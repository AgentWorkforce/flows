import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compileYaml, toKernelSpec } from '../src/compile.js';
import { JournalClient } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SDK = join(ROOT, 'sdk');
const BUILT_CLI = join(SDK, 'dist', 'cli.js');
const TESTDATA = join(ROOT, 'testdata');
const RELAYFLOWD = resolve(
  process.env['RELAYFLOWD_BIN'] ?? join(ROOT, 'kernel', 'target', 'debug', 'relayflowd'),
);
const temporaryDirectories: string[] = [];
const daemons: ChildProcess[] = [];
const clients: JournalClient[] = [];

beforeAll(() => {
  requireExecutable(RELAYFLOWD, 'RELAYFLOWD_BIN', '(cd kernel && ../ops/cargo.sh build)');
  requireExecutable(BUILT_CLI, 'built flows CLI', '(cd sdk && npm run build)');
  console.log(`LIVE_KERNEL relayflowd=${RELAYFLOWD}`);
  console.log(`LIVE_KERNEL flows=${BUILT_CLI}`);
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const daemon of daemons.splice(0)) await stopDaemon(daemon);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('built flows CLI against live relayflowd', () => {
  it('runs rung (a), parks rung (b), and keeps JSON report-shaped', async () => {
    const dataDir = temporaryDirectory('flows-live-cli-');
    await startDaemon(dataDir);

    const deterministic = invokeCli([
      'run', '--data-dir', dataDir, join(TESTDATA, 'hello-deterministic.flow.yaml'),
    ]);
    expect(deterministic.status, deterministic.stderr).toBe(0);
    expect(deterministic.stdout).toMatch(/RUN [0-9A-Z]{26}/);
    expect(deterministic.stdout).toContain('completionReason: success');

    const parked = invokeCli([
      'run', '--data-dir', dataDir, join(TESTDATA, 'hello-llm.flow.yaml'),
    ]);
    expect(parked.status, parked.stderr).toBe(3);
    expect(parked.stderr).toContain('PARKED [run_parked]');
    expect(parked.stderr).toContain('step "answer" (llm)');
    expect(parked.stderr).toContain('no worker is attached');

    const agentParked = invokeCli([
      'run', '--data-dir', dataDir, join(TESTDATA, 'hello-agent.flow.yaml'),
    ]);
    expect(agentParked.status, agentParked.stderr).toBe(3);
    expect(agentParked.stderr).toContain('PARKED [run_parked]');
    expect(agentParked.stderr).toContain('step "edit" (agent)');

    const failedFlow = join(dataDir, 'failed.flow.yaml');
    writeFileSync(failedFlow, `
version: '0.1.0'
steps:
  - id: fail
    type: deterministic
    command: "exit 7"
`);
    const failed = invokeCli(['run', '--data-dir', dataDir, failedFlow]);
    expect(failed.status).toBe(1);
    expect(failed.stderr).toContain('FAILED [step_failed]');
    expect(failed.stdout).toContain('completionReason: step_failed');
    const failedRunId = failed.stdout.match(/RUN ([0-9A-Z]{26})/)?.[1];
    expect(failedRunId).toBeDefined();
    const failedClient = await connectClient(dataDir);
    const failedJournal = (await failedClient.journalRead(failedRunId!, 1)).entries;
    const terminal = failedJournal.find((entry) => journalType(entry) === 'run.completed');
    expect(terminal).toMatchObject({
      entry_type: 'run.completed',
      payload: { completionReason: 'step_failed', failed_step_id: 'fail' },
    });

    const json = invokeCli([
      'run', '--json', '--data-dir', dataDir, join(TESTDATA, 'hello-deterministic.flow.yaml'),
    ]);
    expect(json.status, json.stderr).toBe(0);
    expect(JSON.parse(json.stdout)).toMatchObject({
      ok: true,
      command: 'run',
      status: 'completed',
      completionReason: 'success',
    });

    const invalid = invokeCli(['resume', '--json']);
    expect(invalid.status).toBe(2);
    expect(JSON.parse(invalid.stdout)).toMatchObject({
      ok: false,
      diagnostics: [{ kind: 'invalid_invocation' }],
    });

    const liveClient = await connectClient(dataDir);
    await expect(liveClient.runResume('absent-run')).rejects.toMatchObject({
      code: 'run_not_found',
    });
  });

  it('allows a deterministic run to exceed the bounded request timeout', async () => {
    const dataDir = temporaryDirectory('flows-live-long-run-');
    await startDaemon(dataDir);
    const flow = join(dataDir, 'long.flow.yaml');
    writeFileSync(flow, `
version: '0.1.0'
steps:
  - id: first
    type: deterministic
    command: sleep 16
  - id: second
    type: deterministic
    dependsOn: [first]
    command: sleep 16
`);

    const completed = invokeCli(['run', '--data-dir', dataDir, flow]);

    expect(completed.status, completed.stderr).toBe(0);
    expect(completed.stdout).toContain('completionReason: success');
  }, 45_000);

  it('follows a live worker dispatch through flows run', async () => {
    const dataDir = temporaryDirectory('flows-live-worker-');
    await startDaemon(dataDir);
    const worker = await connectClient(dataDir);
    await worker.hello('live-cli-worker');
    const dispatched = eventOnce<StepDispatchEvent>(worker, 'step.dispatch');
    await worker.workerAttach('live-cli-llm', ['llm']);

    const running = invokeCliAsync([
      'run', '--data-dir', dataDir, join(TESTDATA, 'hello-llm.flow.yaml'),
    ]);
    const lease = await dispatched;
    expect((await worker.runGet(lease.run_id)).steps[lease.step_id]).toEqual({
      type: 'llm',
      state: 'running',
      lease_deadline_ms: lease.lease_deadline_ms,
    });
    await worker.stepComplete(
      lease.run_id,
      lease.step_id,
      lease.attempt,
      lease.idempotency_key,
      'success',
      { output: { answer: 4 }, usage: { tokens_in: 2, tokens_out: 1, dollars: '0.001' } },
    );
    const completed = await running;

    expect(completed.status, completed.stderr).toBe(0);
    expect(completed.stdout).toContain('completionReason: success');
    expect(completed.stderr).not.toContain('protocol_error');
  });

  it('reports a real manual-recovery NeedsHuman state as parked', async () => {
    const dataDir = temporaryDirectory('flows-live-human-');
    await startDaemon(dataDir);
    const flow = join(dataDir, 'manual.flow.yaml');
    writeFileSync(flow, `
version: '0.1.0'
steps:
  - id: edit
    type: agent
    cli: ${JSON.stringify(join(TESTDATA, 'preflight', 'authenticated-cli'))}
    instruction: Edit the repository.
    recoveryMode: manual
    maxIterations: 2
    surfaces:
      workspace:
        - surface: repo
`);
    const worker = await connectClient(dataDir);
    await worker.hello('live-manual-worker');
    const dispatched = eventOnce<StepDispatchEvent>(worker, 'step.dispatch');
    await worker.workerAttach('live-manual-agent', ['agent'], {
      workspace: [{ surface: 'repo', revision_id: 'rev-a' }],
      streams: [],
    });

    const running = invokeCliAsync(['run', '--data-dir', dataDir, flow]);
    const lease = await dispatched;
    worker.close();
    const parked = await running;

    expect(parked.status, parked.stderr).toBe(3);
    expect(parked.stderr).toContain('PARKED [run_parked]');
    expect(parked.stderr).toContain('waiting for human recovery');
    expect(parked.stderr).not.toContain('protocol_error');
    const inspector = await connectClient(dataDir);
    expect((await inspector.runGet(lease.run_id)).steps[lease.step_id]).toMatchObject({
      type: 'agent',
      state: 'needs_human',
    });
  });

  it('preflights before journaling and names an unreachable socket', async () => {
    const dataDir = temporaryDirectory('flows-live-preflight-');
    await startDaemon(dataDir);
    const before = runArtifacts(dataDir);

    const refused = invokeCli([
      'run', '--data-dir', dataDir, join(TESTDATA, 'preflight', 'cli-missing.flow.yaml'),
    ]);
    expect(refused.status).toBe(2);
    expect(refused.stderr).toContain('REFUSED [cli_missing]');
    expect(runArtifacts(dataDir)).toEqual(before);

    const absentDir = temporaryDirectory('flows-live-absent-');
    const absentSocket = join(absentDir, 'relayflowd.sock');
    const unreachable = invokeCli([
      'run', '--data-dir', absentDir, join(TESTDATA, 'hello-deterministic.flow.yaml'),
    ]);
    expect(unreachable.status).toBe(2);
    expect(unreachable.stderr).toContain('REFUSED [daemon_unreachable]');
    expect(unreachable.stderr).toContain(absentSocket);
    expect(unreachable.stderr).toContain('relayflowd --data-dir');
    expect(runArtifacts(absentDir)).toEqual([]);
  });
});

describe('JournalClient wire conformance against live relayflowd', () => {
  it('exercises every protocol-v0 verb with the real server', async () => {
    const dataDir = temporaryDirectory('flows-live-wire-');
    await startDaemon(dataDir);
    const client = await connectClient(dataDir);

    expect(await client.hello('live-conformance')).toEqual({ protocol: 0, server: 'relayflowd' });
    const deterministic = await client.runStart(toKernelSpec(compileYaml(`
version: '0.1.0'
steps:
  - id: hello
    type: deterministic
    command: printf hello
`)));
    expect(deterministic.status).toBe('completed');
    expect(deterministic.completion_reason).toBe('success');
    expect((await client.runResume(deterministic.run_id)).completion_reason).toBe('success');
    expect((await client.runGet(deterministic.run_id)).status).toBe('completed');

    const replayed = eventOnce<Record<string, unknown>>(client, 'entry');
    expect(await client.runWatch(deterministic.run_id)).toEqual({ watching: deterministic.run_id });
    expect((await replayed)['entry_type']).toBe('run.spawned');
    const journal = await client.journalRead(deterministic.run_id, 1);
    expect(journal.entries.some((entry) => journalType(entry) === 'run.completed')).toBe(true);
    expect((await client.eventEmit(deterministic.run_id, 'unmatched', { ok: true })).matched).toBe(0);
    expect((await client.streamAppend(deterministic.run_id, 'results', { answer: 4 })).offset).toBe(0);
    expect(await client.streamRead(deterministic.run_id, 'results', 0, 10)).toEqual({
      messages: [{ answer: 4 }],
      next_offset: 1,
    });

    const llmDispatch = eventOnce<StepDispatchEvent>(client, 'step.dispatch');
    expect(await client.workerAttach('live-llm', ['llm'])).toEqual({ worker_id: 'live-llm' });
    const llmStart = client.runStart(toKernelSpec(compileYaml(`
version: '0.1.0'
steps:
  - id: answer
    type: llm
    prompt: Return four.
`)));
    const llmLease = await llmDispatch;
    const llmParked = await llmStart;
    expect(llmLease.step_type).toBe('llm');
    const heartbeat = await client.stepHeartbeat(
      llmLease.run_id,
      llmLease.step_id,
      llmLease.attempt,
      llmLease.lease_id,
    );
    expect(heartbeat.lease_deadline_ms).toBeGreaterThan(Date.now());
    expect((await client.runGet(llmLease.run_id)).steps[llmLease.step_id]).toMatchObject({
      type: 'llm',
      state: 'running',
      lease_deadline_ms: heartbeat.lease_deadline_ms,
    });
    const llmDone = await client.stepComplete(
      llmLease.run_id,
      llmLease.step_id,
      llmLease.attempt,
      llmLease.idempotency_key,
      'success',
      { output: { answer: 4 }, usage: { tokens_in: 2, tokens_out: 1, dollars: '0.001' } },
    );
    expect(llmParked.status).toBe('parked');
    expect(llmDone.completion_reason).toBe('success');

    const initialPins = {
      workspace: [{ surface: 'repo', revision_id: 'rev-a' }],
      streams: [],
    };
    const agentDispatch = eventOnce<StepDispatchEvent>(client, 'step.dispatch');
    expect(await client.workerAttach('live-agent', ['agent'], initialPins)).toEqual({ worker_id: 'live-agent' });
    const agentStart = client.runStart(toKernelSpec(compileYaml(`
version: '0.1.0'
steps:
  - id: edit
    type: agent
    instruction: Edit the repository.
    surfaces:
      workspace:
        - surface: repo
      external:
        - provider://item
`)));
    const agentLease = await agentDispatch;
    await agentStart;
    let providerCalls = 0;
    expect(await client.performEffect({
      runId: agentLease.run_id,
      stepId: agentLease.step_id,
      attempt: agentLease.attempt,
      idempotencyKey: agentLease.idempotency_key,
      surfacePath: 'provider://item',
      revisionBefore: 'rev-a',
      revisionAfter: 'rev-b',
    }, async () => { providerCalls += 1; })).toBe(true);
    expect(providerCalls).toBe(1);
    const agentDone = await client.stepComplete(
      agentLease.run_id,
      agentLease.step_id,
      agentLease.attempt,
      agentLease.idempotency_key,
      'success',
      {
        output: { changed: true },
        started_pins: agentLease.pins,
        end_pins: { workspace: [{ surface: 'repo', revision_id: 'rev-b' }], streams: [] },
        effects: [{ surface_path: 'provider://item', idempotency_key: agentLease.idempotency_key }],
      },
    );
    expect(agentDone.completion_reason).toBe('success');
  });
});

describe('surface resume after a real daemon kill', () => {
  it('resumes a three-step run with each successful completion exactly once', async () => {
    const directory = temporaryDirectory('flows-live-resume-');
    const dataDir = join(directory, 'data');
    const startedMarker = join(directory, 'second-started');
    const releaseMarker = join(directory, 'release-first-attempt');
    const slowCommand = [
      `if [ -e ${JSON.stringify(startedMarker)} ]; then printf resumed`,
      `else : > ${JSON.stringify(startedMarker)}`,
      `while [ ! -e ${JSON.stringify(releaseMarker)} ]; do sleep 0.05; done`,
      'fi',
    ].join('; ');
    const flow = join(directory, 'three-step.flow.yaml');
    writeFileSync(flow, `
version: '0.1.0'
name: live-crash-resume
steps:
  - id: one
    type: deterministic
    command: printf one
  - id: two
    type: deterministic
    dependsOn: [one]
    command: ${JSON.stringify(slowCommand)}
  - id: three
    type: deterministic
    dependsOn: [two]
    command: printf three
`);
    const firstDaemon = await startDaemon(dataDir);
    const firstRun = invokeCliAsync(['run', '--data-dir', dataDir, flow]);
    const runId = await waitForActiveRun(dataDir, startedMarker);
    const beforeClient = await connectClient(dataDir);
    const before = (await beforeClient.journalRead(runId, 1)).entries;
    expect(successfulCompletions(before)).toEqual({ one: 1 });
    expect((await beforeClient.runGet(runId)).steps['two']).toMatchObject({
      type: 'deterministic',
      state: 'running',
    });
    beforeClient.close();
    clients.splice(clients.indexOf(beforeClient), 1);

    console.log(`LIVE_KERNEL kill -9 pid=${firstDaemon.pid} run=${runId} while step=two state=Running`);
    await stopDaemon(firstDaemon, 'SIGKILL');
    daemons.splice(daemons.indexOf(firstDaemon), 1);
    const interrupted = await firstRun;
    expect(interrupted.status).toBe(1);
    expect(interrupted.stderr).toContain('FAILED [protocol_error]');
    writeFileSync(releaseMarker, 'release');
    await startDaemon(dataDir);

    const resumed = invokeCli([
      'resume', '--json', '--data-dir', dataDir, runId,
    ]);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      ok: true,
      command: 'resume',
      runId,
      status: 'completed',
      completionReason: 'success',
    });

    const afterClient = await connectClient(dataDir);
    const after = (await afterClient.journalRead(runId, 1)).entries;
    expect(successfulCompletions(after)).toEqual({ one: 1, two: 1, three: 1 });
    expect(completionReasons(after, 'two')).toEqual(['crashed', 'success']);
  });
});

function requireExecutable(path: string, source: string, buildCommand: string): void {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(
      `LIVE_KERNEL_MISSING: ${source} does not name an executable file: ${path}. Build it with: ${buildCommand}`,
    );
  }
}

function temporaryDirectory(prefix: string): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

async function startDaemon(dataDir: string): Promise<ChildProcess> {
  const daemon = spawn(RELAYFLOWD, ['--data-dir', dataDir, 'serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemons.push(daemon);
  const stderr: Buffer[] = [];
  daemon.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  const socket = join(dataDir, 'relayflowd.sock');
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (existsSync(socket) && lstatSync(socket).isSocket()) return daemon;
    if (daemon.exitCode !== null || daemon.signalCode !== null) {
      throw new Error(`relayflowd exited before binding ${socket}: ${Buffer.concat(stderr).toString('utf8')}`);
    }
    await delay(20);
  }
  throw new Error(`relayflowd did not bind ${socket} within 5000ms`);
}

async function stopDaemon(daemon: ChildProcess, signal: NodeJS.Signals = 'SIGTERM'): Promise<void> {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => daemon.once('exit', () => resolveExit()));
  daemon.kill(signal);
  await exited;
}

async function connectClient(dataDir: string): Promise<JournalClient> {
  const client = new JournalClient(join(dataDir, 'relayflowd.sock'), { requestTimeoutMs: 5_000 });
  clients.push(client);
  await client.connect();
  return client;
}

function invokeCli(args: string[]) {
  return spawnSync(process.execPath, [BUILT_CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

function invokeCliAsync(args: string[]): Promise<{ status: number | null; stdout: string; stderr: string }> {
  const child = spawn(process.execPath, [BUILT_CLI, ...args], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  daemons.push(child);
  const stdout: Buffer[] = [];
  const stderr: Buffer[] = [];
  child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk));
  child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk));
  return new Promise((resolveExit) => child.once('exit', (status) => resolveExit({
    status,
    stdout: Buffer.concat(stdout).toString('utf8'),
    stderr: Buffer.concat(stderr).toString('utf8'),
  })));
}

async function waitForActiveRun(dataDir: string, marker: string): Promise<string> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const runs = join(dataDir, 'runs');
    const journal = existsSync(runs)
      ? readdirSync(runs).find((name) => /^[0-9A-Z]{26}\.sqlite3$/.test(name))
      : undefined;
    if (existsSync(marker) && journal !== undefined) return journal.slice(0, -'.sqlite3'.length);
    await delay(20);
  }
  throw new Error(`run did not reach the marked in-flight step within 5000ms: ${marker}`);
}

function runArtifacts(dataDir: string): string[] {
  return readdirSync(dataDir).filter((name) => name !== 'relayflowd.sock').sort();
}

function eventOnce<T>(client: JournalClient, event: string): Promise<T> {
  return new Promise<T>((resolveEvent) => client.once(event, (value) => resolveEvent(value as T)));
}

function journalType(entry: unknown): string | undefined {
  return isObject(entry) && typeof entry['entry_type'] === 'string' ? entry['entry_type'] : undefined;
}

function successfulCompletions(entries: unknown[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of entries) {
    if (!isObject(entry) || entry['entry_type'] !== 'step.completed') continue;
    const payload = entry['payload'];
    const stepId = entry['step_id'];
    if (!isObject(payload) || payload['completionReason'] !== 'success' || typeof stepId !== 'string') continue;
    counts[stepId] = (counts[stepId] ?? 0) + 1;
  }
  return counts;
}

function completionReasons(entries: unknown[], stepId: string): string[] {
  return entries.flatMap((entry) => {
    if (!isObject(entry) || entry['entry_type'] !== 'step.completed' || entry['step_id'] !== stepId) return [];
    const payload = entry['payload'];
    return isObject(payload) && typeof payload['completionReason'] === 'string'
      ? [payload['completionReason']]
      : [];
  });
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
