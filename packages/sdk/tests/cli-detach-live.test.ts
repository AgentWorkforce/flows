import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { accessSync, chmodSync, constants, existsSync, mkdtempSync, symlinkSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as sleep } from 'node:timers/promises';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';
import { socketPathFor } from '../src/daemon-connection.js';
import type { StepDispatchEvent } from '../src/protocol.js';
import type { DetachedHandle } from '../src/cli/detached-run.js';
import { readDetachedRecord } from '../src/cli/detached-record.js';

const cli = resolve('dist/cli.js');
let relayflowd: string;
const roots: string[] = [];
const terminals: ChildProcess[] = [];
const workers: number[] = [];
beforeAll(() => {
  relayflowd = process.env['RELAYFLOWD_BIN'] ?? join(JSON.parse(execFileSync('sh', [
    resolve('../../ops/cargo.sh'), 'metadata', '--format-version=1', '--no-deps', '--locked', '--offline',
  ], { cwd: resolve('../../kernel'), encoding: 'utf8' })).target_directory, 'debug/relayflowd');
  accessSync(relayflowd, constants.X_OK);
  accessSync(cli, constants.X_OK);
  console.log(`LIVE_KERNEL relayflowd=${relayflowd}`);
  console.log(`LIVE_KERNEL flows=${cli}`);
});
afterEach(async () => {
  for (const child of terminals.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) {
      const exit = new Promise<void>(done => child.once('exit', () => done()));
      process.kill(-child.pid!, 'SIGTERM');
      await exit;
    }
  }
  for (const pid of workers.splice(0)) {
    try { process.kill(pid, 'SIGTERM'); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
    }
  }
  for (const root of roots.splice(0)) {
    const connection = join(root, 'data/connection.json');
    if (existsSync(connection)) {
      const { pid } = JSON.parse(readFileSync(connection, 'utf8'));
      try { process.kill(pid, 'SIGTERM'); } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flows-detach-'));
  roots.push(root);
  symlinkSync(resolve('node_modules'), join(root, 'node_modules'));
  const dataDir = join(root, 'data');
  const env = { ...process.env, RELAYFLOWD_BIN: relayflowd, FLOWS_NO_SPAWN: '0', FLOWS_CLOUD_MIRROR: '0' };
  delete env['FLOWS_LOCAL_AGENT_ENV_FD'];
  const agent = join(root, 'agent.mjs');
  const started = join(root, 'agent-started');
  const release = join(root, 'release');
  const done = join(root, 'done');
  const wrapper = pathToFileURL(resolve('../../testdata/preflight/wrapper-session.mjs')).href;
  writeFileSync(agent, `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(wrapper)};
import { existsSync, writeFileSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
if (process.argv[2] === 'auth' && process.argv[3] === 'status') process.exit(0);
const request = await receiveWrapperRequest();
if (request) {
  writeFileSync(${JSON.stringify(started)}, String(process.pid));
  while (!existsSync(${JSON.stringify(release)})) await sleep(25);
  console.log('{"answer":"done"}');
}
`);
  chmodSync(agent, 0o755);
  writeFileSync(join(root, 'flows.json'), JSON.stringify({ cli: agent }));
  const yaml = join(root, 'flow.yaml');
  writeFileSync(yaml, JSON.stringify({ version: '0.1.0', name: 'detached-agent', steps: [
    { id: 'agent', type: 'agent', cli: agent, instruction: 'wait for release' },
    { id: 'finish', type: 'deterministic', dependsOn: ['agent'], command: `printf done > ${done}` },
  ] }));
  const authored = join(root, 'body.flow.ts');
  writeFileSync(authored, `import { flow } from '@relayflows/surface';
export default flow('detached-body', async f => {
  await f.agent('waiting', { task: 'wait for release' });
  await f.run(${JSON.stringify(`printf done > ${done}`)});
  f.done('success');
});\n`);
  const invoke = (args: string[]) => spawnSync(process.execPath, [cli, ...args, '--data-dir', dataDir],
    { cwd: root, env, encoding: 'utf8', timeout: 30_000 });
  return { root, dataDir, env, started, release, done, yaml, authored, invoke };
}

async function waitUntil(predicate: () => boolean, description: string): Promise<void> {
  const deadline = Date.now() + 20_000;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${description}`);
    await sleep(25);
  }
}

describe('detached runs through a real terminal process group', () => {
  it.each(['yaml', 'authored', 'resume'] as const)('%s completes after the invoking terminal group is killed mid-agent', async kind => {
    const f = fixture();
    let args = ['run', kind === 'authored' ? f.authored : f.yaml];
    if (kind === 'authored') args.push('--input', '{}');
    if (kind === 'resume') {
      const parked = f.invoke(['run', f.yaml, '--json', '--no-observer-link']);
      expect(parked.status, parked.stdout + parked.stderr).toBe(3);
      args = ['resume', JSON.parse(parked.stdout).runId];
    }
    args.push('--local-agent', '--json', '--no-observer-link', '--data-dir', f.dataDir, '--detach');
    const resultPath = join(f.root, 'parent-result.json');
    // This process is the terminal/session leader. The invoking CLI exits,
    // then this group stays alive until the test closes the terminal mid-step.
    const terminal = spawn(process.execPath, ['--input-type=module', '-e', `
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const result = spawnSync(process.execPath, ${JSON.stringify([cli, ...args])}, { encoding: 'utf8' });
writeFileSync(${JSON.stringify(resultPath)}, JSON.stringify({ status: result.status, stdout: result.stdout, stderr: result.stderr }));
setInterval(() => {}, 1000);
`], { detached: true, cwd: f.root, env: f.env, stdio: 'ignore' });
    terminals.push(terminal);
    await waitUntil(() => existsSync(resultPath), 'parent exit');
    const result = JSON.parse(readFileSync(resultPath, 'utf8'));
    console.log(`PARENT ${JSON.stringify([process.execPath, cli, ...args])}\n${JSON.stringify(result)}`);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const handle = JSON.parse(result.stdout) as DetachedHandle;
    workers.push(handle.pid);
    expect(handle).toMatchObject({ detached: true, runId: expect.any(String) });
    expect(handle).not.toHaveProperty('observerUrl');
    await waitUntil(() => existsSync(f.started), `agent start; log=${handle.logPath}`);
    expect(existsSync(f.done)).toBe(false);
    const exited = new Promise<void>(done => terminal.once('exit', () => done()));
    console.log(`kill -TERM -- -${terminal.pid}`);
    process.kill(-terminal.pid!, 'SIGTERM');
    await exited;
    expect(terminal.signalCode).toBe('SIGTERM');
    // Only after the terminal has died may either the worker or the authored
    // body continue. A detached daemon alone cannot satisfy this assertion.
    writeFileSync(f.release, 'go');
    await waitUntil(() => readDetachedRecord(handle.recordPath)?.phase === 'finished', 'child completion');
    expect(readDetachedRecord(handle.recordPath)?.execution, readFileSync(handle.logPath, 'utf8')).toMatchObject({ exitCode: 0 });
    const status = f.invoke(['status', '--json', handle.runId]);
    console.log(`STATUS ${JSON.stringify([process.execPath, cli, 'status', '--json', handle.runId, '--data-dir', f.dataDir])}\n${status.stdout}${status.stderr}`);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout)).toMatchObject({ status: 'completed', completion_reason: 'success' });
    expect(readFileSync(f.done, 'utf8')).toBe('done');
  }, 45_000);

  it('returns the child preflight refusal instead of a detached success', () => {
    const f = fixture();
    writeFileSync(f.yaml, 'broken: [');
    const result = f.invoke(['run', f.yaml, '--json', '--no-observer-link', '--detach']);
    expect(result.status, result.stderr + result.stdout).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({ ok: false, diagnostics: [expect.objectContaining({ severity: 'refusal' })] });
    expect(JSON.parse(result.stdout)).not.toHaveProperty('detached');
    expect(existsSync(join(f.dataDir, 'connection.json'))).toBe(false);
  });

  it('a completed authored root resumes detached, but a pre-admission source failure keeps its exit code', async () => {
    const f = fixture();
    const pinned = join(f.root, 'pinned.flow.ts');
    writeFileSync(pinned, `import { flow } from '@relayflows/surface';
export default flow('detached-pinned', async f => { await f.run('printf ok'); f.done('success'); });\n`);
    const ran = f.invoke(['run', pinned, '--input', '{}', '--json', '--no-observer-link']);
    expect(ran.status, ran.stdout + ran.stderr).toBe(0);
    const runId = JSON.parse(ran.stdout).runId as string;
    // Admission of an already completed root publishes no run.started, only the receipt.
    const again = f.invoke(['resume', runId, '--json', '--no-observer-link', '--detach']);
    expect(again.status, again.stdout + again.stderr).toBe(0);
    const handle = JSON.parse(again.stdout) as DetachedHandle;
    workers.push(handle.pid);
    expect(handle).toMatchObject({ detached: true, runId });
    await waitUntil(() => readDetachedRecord(handle.recordPath)?.phase === 'finished', 'completed root receipt');
    expect(readDetachedRecord(handle.recordPath)?.execution).toMatchObject({ exitCode: 0 });

    writeFileSync(pinned, readFileSync(pinned, 'utf8').replace("printf ok", "printf changed"));
    const foreground = f.invoke(['resume', runId, '--json', '--no-observer-link']);
    expect(foreground.status, foreground.stdout + foreground.stderr).toBe(1);
    expect(foreground.stdout).toContain('authority mismatch');
    const detached = f.invoke(['resume', runId, '--json', '--no-observer-link', '--detach']);
    expect(detached.status, detached.stdout + detached.stderr).toBe(1);
    const report = JSON.parse(detached.stdout);
    expect(report).not.toHaveProperty('detached');
    expect(JSON.stringify(report.diagnostics)).toContain('authority mismatch');
  }, 45_000);

  it('does not report a missing resume target as admitted', () => {
    const f = fixture();
    const result = f.invoke(['resume', '01ARZ3NDEKTSV4RRFFQ69G5FAV', '--json', '--no-observer-link', '--detach']);
    expect(result.status, result.stderr + result.stdout).not.toBe(0);
    expect(JSON.parse(result.stdout)).not.toHaveProperty('detached');
  });

  it('replayed history cannot acknowledge a human-influenced resume refusal', async () => {
    const f = fixture();
    // Boot the daemon, then create a run with one accepted human intervention.
    expect(f.invoke(['run', f.yaml, '--json', '--no-observer-link']).status).toBe(3);
    const client = new JournalClient(socketPathFor(f.dataDir));
    await client.connect();
    try {
      await client.hello('detach-human-refusal');
      const dispatched = new Promise<StepDispatchEvent>(resolve => client.once('step.dispatch', resolve));
      await client.workerAttach('human-fixture', ['agent'], { workspace: [], streams: [{ stream: 'first', read_offset: 0 }] });
      const run = await client.runStart({ version: '0.1.0', name: 'human-influenced', steps: [
        { id: 'first', type: 'agent', instruction: 'manual fixture', recovery_mode: 'reset', max_iterations: 1 },
        { id: 'later', type: 'agent', instruction: 'needs another worker', depends_on: ['first'],
          recovery_mode: 'reset', max_iterations: 1, surfaces: { streams: [{ stream: 'missing' }] } },
      ] });
      const dispatch = await dispatched;
      await client.stepComplete(run.run_id, dispatch.step_id, dispatch.attempt, dispatch.idempotency_key, 'success', {
        human_intervention: true, started_pins: dispatch.pins, end_pins: dispatch.pins,
      });
      const refused = f.invoke(['resume', run.run_id, '--json', '--no-observer-link', '--detach']);
      expect(refused.status, refused.stdout + refused.stderr).toBe(2);
      expect(JSON.parse(refused.stdout)).toMatchObject({ diagnostics: [expect.objectContaining({ kind: 'human_influenced_run' })] });
      const allowed = f.invoke(['resume', run.run_id, '--json', '--no-observer-link', '--detach', '--allow-human-influenced']);
      expect(allowed.status, allowed.stdout + allowed.stderr).toBe(0);
      workers.push(JSON.parse(allowed.stdout).pid);
      expect(JSON.parse(allowed.stdout)).toMatchObject({ detached: true, runId: run.run_id });
    } finally { client.close(); }
  });

  it('retains a parked outcome and remedy in the child log and receipt', async () => {
    const f = fixture();
    const result = f.invoke(['run', f.yaml, '--json', '--no-observer-link', '--detach']);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const handle = JSON.parse(result.stdout) as DetachedHandle;
    workers.push(handle.pid);
    await waitUntil(() => readDetachedRecord(handle.recordPath)?.phase === 'finished', 'park receipt');
    expect(handle.notice).toContain('park');
    expect(readDetachedRecord(handle.recordPath)?.execution).toMatchObject({ exitCode: 3, report: { parkCause: 'worker_unavailable' } });
    await waitUntil(() => readFileSync(handle.logPath, 'utf8').includes('--local-agent'), 'park remedy log');
  });
});
