import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { AUTHORED_STEP_STREAM } from '../src/authored-step-index.js';
import { JournalClient } from '../src/journal-client.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { chainFixture } from './flow-chain-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });

function fixture(pause: boolean, gate = true) {
  const f = chainFixture();
  cleanups.push(() => f.close());
  writeFileSync(f.wrapper, `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(resolve('../../testdata/preflight/wrapper-session.mjs'))};
import { appendFileSync, writeFileSync } from 'node:fs';
if (process.argv[2] === 'auth') process.exit(0);
const request = await receiveWrapperRequest();
if (request?.instruction.includes('TIMEOUT_TEST')) {
  appendFileSync(${JSON.stringify(f.calls)}, 'executed\\n');
  writeFileSync(${JSON.stringify(join(f.root, 'work.txt'))}, 'keep this work');
  writeFileSync(${JSON.stringify(join(f.root, 'agent.pid'))}, String(process.pid));
  setInterval(() => {}, 1000);
} else if (request) process.stdout.write('probe ok');
`);
  writeFileSync(f.flowPath, `import { flow } from '@relayflows/surface';
export default flow('timeout-test', { budget: { wallclock: '2m' } }, async f => {
  const result = await f.agent('repair', { task: 'TIMEOUT_TEST', timeout: '300ms' })
    .gate(r => r.completionReason === 'timeout' && ${gate});
  if (result.completionReason === 'timeout') {
    await f.run(${JSON.stringify(pause ? 'test -f paused || { touch paused; sleep 120; }; cat work.txt > published' : 'cat work.txt > published')});
  }
  f.done('success');
});
`);
  return f;
}

async function evidence(f: ReturnType<typeof fixture>) {
  const root = readdirSync(join(f.data, 'runs')).filter(x => x.endsWith('.sqlite3')).sort()[0]!.slice(0, -8);
  const client = new JournalClient(socketPathFor(f.data));
  await client.connect(); await client.hello('agent-timeout-test');
  try {
    const records = (await client.streamRead(root, AUTHORED_STEP_STREAM, 0, 1000)).messages
      .map((m: any) => m.message ?? m) as Array<Record<string, unknown>>;
    const child = records.find(r => r.state === 'completed' && r.completionReason === 'timeout')!;
    expect(child).toBeDefined();
    const entries = (await client.journalRead(child.runId as string, 1, 1000)).entries as any[];
    expect(entries.filter(e => e.entry_type === 'step.completed').map(e => e.payload.completionReason)).toEqual(['timeout']);
    expect(entries.find(e => e.entry_type === 'run.spawned').payload.spec.steps[0].timeout_ms).toBe(300);
    expect((await client.runGet(child.runId as string)).status).toBe('failed');
  } finally { client.close(); }
  return root;
}

it('journals timeout, stops the process, runs a predicate gate and publishes under a budget header', async () => {
  const f = fixture(false);
  const run = f.invoke('run', '--local-agent', '--no-observer-link', '--json', '--data-dir', f.data, f.flowPath, '--input', '{}');
  expect(run.status, run.stdout + run.stderr).toBe(0);
  expect(JSON.parse(run.stdout).completionReason).toBe('success');
  expect(readFileSync(join(f.root, 'published'), 'utf8')).toBe('keep this work');
  expect(readFileSync(f.calls, 'utf8')).toBe('executed\n');
  expect(() => process.kill(Number(readFileSync(join(f.root, 'agent.pid'), 'utf8')), 0)).toThrow();
  await evidence(f);
}, 60000);

it('replays timeout after killing the root and daemon, without executing the agent again', async () => {
  const f = fixture(true);
  const run = f.invokeAsync('run', '--local-agent', '--no-observer-link', '--json', '--data-dir', f.data, f.flowPath, '--input', '{}');
  let output = '';
  run.stdout?.on('data', chunk => { output += chunk; });
  run.stderr?.on('data', chunk => { output += chunk; });
  const deadline = Date.now() + 30000;
  while (!existsSync(join(f.root, 'paused'))) {
    if (Date.now() > deadline || run.exitCode !== null) throw new Error(`did not reach publish: ${output}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  const root = await evidence(f);
  const exited = new Promise<void>(resolve => run.once('exit', () => resolve()));
  run.kill('SIGKILL'); await exited;
  const { pid } = JSON.parse(readFileSync(join(f.data, 'connection.json'), 'utf8'));
  process.kill(pid, 'SIGKILL');
  const resumed = f.invoke('resume', '--local-agent', '--no-observer-link', '--json', '--data-dir', f.data, root);
  expect(resumed.status, resumed.stdout + resumed.stderr).toBe(0);
  expect(JSON.parse(resumed.stdout).completionReason).toBe('success');
  expect(readFileSync(f.calls, 'utf8')).toBe('executed\n');
  expect(readFileSync(join(f.root, 'published'), 'utf8')).toBe('keep this work');
  await evidence(f);
}, 90000);

it('lets an author reject timeout through a predicate gate', async () => {
  const f = fixture(false, false);
  const run = f.invoke('run', '--local-agent', '--no-observer-link', '--json', '--data-dir', f.data, f.flowPath, '--input', '{}');
  expect(run.status, run.stdout + run.stderr).not.toBe(0);
  expect(existsSync(join(f.root, 'published'))).toBe(false);
  expect(readFileSync(f.calls, 'utf8')).toBe('executed\n');
}, 60000);
