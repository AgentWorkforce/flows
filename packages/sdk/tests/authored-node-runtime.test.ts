import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';
import { socketFor } from '../src/cli/run.js';
import { assertAuthoredNodeVersion } from '../src/authored-runtime-capability.js';

const root = resolve('../..'), sdk = resolve('.');
const fixtures: string[] = [];
let stage: string, cli: string;
const daemon = process.env['RELAYFLOWD_BIN'] ?? resolve('../../kernel/target/debug/relayflowd');
const bun = process.env['FLOWS_BUILD_BUN'] ?? 'bun';
const wrapperHelper = resolve('../../testdata/preflight/wrapper-session.mjs');

beforeAll(() => {
  expect(spawnSync(bun, ['--version'], { encoding: 'utf8' }).stdout.trim()).toBe('1.4.0');
  expect(existsSync(daemon), 'build the current kernel or set RELAYFLOWD_BIN').toBe(true);
  stage = mkdtempSync(join(tmpdir(), 'authored-standalone-build-'));
  cli = join(stage, 'flows');
  const built = spawnSync(process.execPath, [join(root, 'scripts/build-standalone-cli.mjs'),
    process.platform === 'darwin' ? 'bun-darwin-arm64' : 'bun-linux-x64', cli], {
    cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, FLOWS_BUILD_BUN: bun },
  });
  expect(built.status, built.stderr + built.stdout).toBe(0);
}, 130_000);

afterAll(() => {
  for (const directory of fixtures) {
    const connection = join(directory, 'data/connection.json');
    if (existsSync(connection)) {
      const { pid } = JSON.parse(readFileSync(connection, 'utf8'));
      if (typeof pid === 'number') { try { process.kill(pid, 'SIGTERM'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      } }
    }
    rmSync(directory, { recursive: true, force: true });
  }
  if (stage) rmSync(stage, { recursive: true, force: true });
});

function fixture(body: string) {
  const directory = mkdtempSync(join(tmpdir(), 'authored-node-runtime-')); fixtures.push(directory);
  const surface = join(directory, 'node_modules/@relayflows/surface');
  cpSync(join(sdk, 'node_modules/@relayflows/surface'), surface, { recursive: true });
  const manifest = JSON.parse(readFileSync(join(surface, 'package.json'), 'utf8'));
  // Same verified execution envelope Cloud uses around the unchanged Surface payload.
  writeFileSync(join(surface, 'package.json'), JSON.stringify({ name: manifest.name,
    version: manifest.version, private: true, type: 'module', types: './index.d.ts',
    exports: { '.': './index.js', './runtime': './runtime.js', './triggers': './triggers/index.js', './triggers/*': './triggers/*.js' } }));
  writeFileSync(join(surface, 'index.js'), "export * from './dist/index.js';\n");
  writeFileSync(join(surface, 'runtime.js'), "export { getFlowDefinition } from './dist/flow.js';\n");
  writeFileSync(join(surface, 'index.d.ts'), "export * from './dist/index.js';\n");
  writeFileSync(join(directory, 'package.json'), '{"type":"module"}');
  const wrapper = join(directory, 'agent.mjs');
  writeFileSync(wrapper, `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(wrapperHelper)};
import { appendFileSync } from 'node:fs';
if(process.argv[2]==='auth') process.exit(0);
const request=await receiveWrapperRequest();
if(request){appendFileSync('agent-effects','once\\n');await new Promise(r=>setTimeout(r,100));console.log('agent-ok');}
`);
  chmodSync(wrapper, 0o755);
  writeFileSync(join(directory, 'flows.json'), JSON.stringify({ cli: wrapper }));
  writeFileSync(join(directory, 'case.flow.ts'), `import {flow} from '@relayflows/surface';
import {appendFileSync,existsSync,writeFileSync} from 'node:fs';
export default flow('runtime-case',async f=>{${body}});
`);
  const env = { ...process.env, FLOWS_AUTHORED_NODE: process.execPath,
    RELAYFLOWD_BIN: daemon, NODE_PATH: join(directory, 'node_modules') };
  const flags = ['--local-agent', '--data-dir', join(directory, 'data'), '--json', '--no-observer-link'];
  const invoke = (args: string[], overrides: NodeJS.ProcessEnv = {}) => spawnSync(cli, [...args, ...flags], {
    cwd: directory, env: { ...env, ...overrides }, encoding: 'utf8', timeout: 60_000,
  });
  return { directory, env, flags, invoke, run: () => invoke(['run', 'case.flow.ts', '--input', '{}']) };
}

const sequential = `await f.agent('worker',{task:'local fixture'});
await f.run("printf one >> run-effects");
await f.run("printf two >> run-effects");
await f.run("printf three >> run-effects");`;

async function entries(directory: string, runId: string) {
  const client = new JournalClient(socketFor(join(directory, 'data')));
  await client.connect(); await client.hello('authored-node-test');
  try { return (await client.journalRead(runId, 1)).entries as Array<{entry_type:string;step_id?:string;payload:Record<string,any>}>; }
  finally { client.close(); }
}

describe('Bun 1.4.0 standalone → native Node authored lifecycle', () => {
  it('awaits agent plus three run steps and resumes without repeating effects', async () => {
    const f = fixture(sequential + `f.done('success');`);
    const first = f.run(); expect(first.status, first.stderr + first.stdout).toBe(0);
    const report = JSON.parse(first.stdout); expect(report).toMatchObject({ok:true,completionReason:'success',completedSteps:5});
    const resumed = f.invoke(['resume', report.runId]); expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
    expect(JSON.parse(resumed.stdout).runId).toBe(report.runId);
    expect(readFileSync(join(f.directory,'agent-effects'),'utf8')).toBe('once\n');
    expect(readFileSync(join(f.directory,'run-effects'),'utf8')).toBe('onetwothree');
    const rootEntries = await entries(f.directory, report.runId);
    expect(rootEntries.filter(e=>e.entry_type==='step.attempt.started')).toHaveLength(1);
    const output = rootEntries.find(e=>e.entry_type==='step.completed')!.payload['output'];
    expect(output.executionRuntime).toMatchObject({kind:'node',version:process.versions.node});
    expect(output.executionRuntime.executableSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(output.executionRuntime.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(output.journalSteps.map((s:{id:string})=>s.id)).toEqual(['agent-1','run-2','run-3','run-4','complete-5']);
  }, 90_000);

  it('stops on parent death and replays completed children under the same unfinished root', async () => {
    const f=fixture(sequential + `
if(!existsSync('resume-ready')){
  writeFileSync('node-pid',String(process.pid));
  writeFileSync('resume-ready','yes');
  await new Promise(()=>{});
}
f.done('success');`);
    const child=spawn(cli,['run','case.flow.ts','--input','{}',...f.flags],{
      cwd:f.directory,env:f.env,stdio:['ignore','pipe','pipe'],
    });
    let logs='';child.stdout.on('data',bytes=>{logs+=bytes});child.stderr.on('data',bytes=>{logs+=bytes});
    const closed=new Promise<void>(resolve=>child.once('close',()=>resolve()));
    let nodePid:number|undefined;
    try {
      const deadline=Date.now()+15_000;
      while(!existsSync(join(f.directory,'resume-ready')) && Date.now()<deadline){
        if(child.exitCode!==null)throw new Error(logs);
        await new Promise(r=>setTimeout(r,50));
      }
      expect(existsSync(join(f.directory,'resume-ready')),logs).toBe(true);
      nodePid=Number(readFileSync(join(f.directory,'node-pid'),'utf8'));
      let rootId:string|undefined;
      for(const file of readdirSync(join(f.directory,'data/runs')).filter(name=>name.endsWith('.sqlite3'))){
        const id=file.slice(0,-8);const journal=await entries(f.directory,id);
        if(journal[0]?.payload['spec']?.steps?.[0]?.id==='authored-root')rootId=id;
      }
      expect(rootId).toBeDefined();
      child.kill('SIGKILL');await closed;
      let alive=true;
      for(let attempt=0;attempt<100;attempt++){
        try{process.kill(nodePid,0);}catch(error){
          if((error as NodeJS.ErrnoException).code==='ESRCH'){alive=false;break;}throw error;
        }
        await new Promise(r=>setTimeout(r,20));
      }
      expect(alive,'lease-owning parent loss must terminate Node body').toBe(false);nodePid=undefined;
      const resumed=f.invoke(['resume',rootId!]);expect(resumed.status,resumed.stderr+resumed.stdout).toBe(0);
      expect(JSON.parse(resumed.stdout).runId).toBe(rootId);
      expect(readFileSync(join(f.directory,'agent-effects'),'utf8')).toBe('once\n');
      expect(readFileSync(join(f.directory,'run-effects'),'utf8')).toBe('onetwothree');
      const rootJournal=await entries(f.directory,rootId!);
      expect(rootJournal.filter(e=>e.entry_type==='step.attempt.started')).toHaveLength(2);
      expect(rootJournal.filter(e=>e.entry_type==='run.completed')).toHaveLength(1);
      expect(rootJournal.at(-1)?.payload['completionReason']).toBe('success');
    } finally {
      child.kill('SIGKILL');
      if(nodePid!==undefined){try{process.kill(nodePid,'SIGKILL');}catch(error){if((error as NodeJS.ErrnoException).code!=='ESRCH')throw error;}}
    }
  },60_000);

  it.each([
    ['unawaited', `f.run("printf ignored >> forbidden-effects");f.done('success');`],
    ['manual then', `f.run("printf chained >> chain-effects").then(()=>undefined);await new Promise(r=>setTimeout(r,100));f.done('success');`],
  ])('refuses %s rather than reporting terminal success', (_name,body) => {
    const f=fixture(body);const result=f.run();expect(result.status).toBe(1);
    expect(result.stdout+result.stderr).toContain('unawaited_step');
    expect(existsSync(join(f.directory,'forbidden-effects'))).toBe(false);
  }, 60_000);

  it('refuses missing Node before body effects or root admission', () => {
    const f=fixture(`writeFileSync('body-started','bad');${sequential}f.done('success');`);
    const result=f.invoke(['run','case.flow.ts','--input','{}'],{FLOWS_AUTHORED_NODE:join(f.directory,'missing-node')});
    expect(result.status).toBe(2);expect(result.stdout+result.stderr).toContain('unsupported_promise_lifecycle');
    expect(existsSync(join(f.directory,'body-started'))).toBe(false);
    expect(existsSync(join(f.directory,'agent-effects'))).toBe(false);
  }, 30_000);

  it('refuses an old Node candidate before body effects', () => {
    expect(()=>assertAuthoredNodeVersion('22.13.0')).toThrow('Node >=22.14');
    const f=fixture(`writeFileSync('body-started','bad');f.done('success');`);
    const old=join(f.directory,'old-node');
    writeFileSync(old, '#!/bin/sh\nprintf \'%s\' \''+JSON.stringify({path:old,version:'20.19.0'})+'\'\n');chmodSync(old,0o755);
    const result=f.invoke(['run','case.flow.ts','--input','{}'],{FLOWS_AUTHORED_NODE:old});
    expect(result.status).toBe(2);expect(existsSync(join(f.directory,'body-started'))).toBe(false);
  }, 30_000);
});
