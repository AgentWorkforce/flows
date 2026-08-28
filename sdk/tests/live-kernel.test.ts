import {
  accessSync,
  constants,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { compileYaml, compileYamlToCanonicalJson, toKernelSpec } from '../src/compile.js';
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
    expect((await client.stepHeartbeat(
      llmLease.run_id,
      llmLease.step_id,
      llmLease.attempt,
      llmLease.lease_id,
    )).lease_deadline_ms).toBeGreaterThan(Date.now());
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
    const yaml = `
version: '0.1.0'
name: live-crash-resume
steps:
  - id: one
    type: deterministic
    command: printf one
  - id: two
    type: deterministic
    dependsOn: [one]
    command: printf two
  - id: three
    type: deterministic
    dependsOn: [two]
    command: printf three
`;
    const specPath = join(directory, 'three-step.spec.json');
    writeFileSync(specPath, compileYamlToCanonicalJson(yaml));
    const interrupted = spawnSync(RELAYFLOWD, [
      '--data-dir', dataDir, 'run', specPath, '--stop-after', '1',
    ], { encoding: 'utf8' });
    expect(interrupted.status, interrupted.stderr).toBe(0);
    const initial = JSON.parse(interrupted.stdout) as { run_id: string; status: string };
    expect(initial.status).toBe('interrupted');

    const firstDaemon = await startDaemon(dataDir);
    const beforeClient = await connectClient(dataDir);
    const before = (await beforeClient.journalRead(initial.run_id, 1)).entries;
    expect(successfulCompletions(before)).toEqual({ one: 1 });
    beforeClient.close();
    clients.splice(clients.indexOf(beforeClient), 1);

    console.log(`LIVE_KERNEL kill -9 pid=${firstDaemon.pid} run=${initial.run_id}`);
    await stopDaemon(firstDaemon, 'SIGKILL');
    daemons.splice(daemons.indexOf(firstDaemon), 1);
    await startDaemon(dataDir);

    const resumed = invokeCli([
      'resume', '--json', '--data-dir', dataDir, initial.run_id,
    ]);
    expect(resumed.status, resumed.stderr).toBe(0);
    expect(JSON.parse(resumed.stdout)).toMatchObject({
      ok: true,
      command: 'resume',
      runId: initial.run_id,
      status: 'completed',
      completionReason: 'success',
    });

    const afterClient = await connectClient(dataDir);
    const after = (await afterClient.journalRead(initial.run_id, 1)).entries;
    expect(successfulCompletions(after)).toEqual({ one: 1, two: 1, three: 1 });
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

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
