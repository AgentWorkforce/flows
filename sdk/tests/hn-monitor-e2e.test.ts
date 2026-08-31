/**
 * End-to-end integration test for HnMonitorRunner against a live relayflowd.
 *
 * This is the workload-actually-runs proof gate 2 requires (RFC-0001 §3
 * rule 2): a real HN event submitted through the journal, the kernel wakes
 * a run, dispatches the agent step to the attached worker, the worker
 * completes it, and the run reaches `done`. All in-process, no external
 * network, no LLM calls — the agent step's `cli` is `echo` so the completion
 * is deterministic.
 *
 * Runs against a fresh relayflowd instance per case; requires the daemon
 * binary present at $RELAYFLOWD_BIN (or the toolchain-external default).
 * Follows the same setup pattern as sdk/tests/live-kernel.test.ts.
 */

import { accessSync, constants, existsSync, lstatSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';
import { AgentWorker } from '../src/worker.js';
import { HnMonitorRunner } from '../src/hn-monitor-runner.js';
import type { StepDispatchEvent, RunGetResult } from '../src/protocol.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const TOOLCHAIN_TARGET =
  process.env['CARGO_TARGET_DIR'] ??
  join(process.env['RELAYFLOWS_TOOLCHAIN_HOME'] ?? join(homedir(), '.relayflows-toolchain'), 'target');
const RELAYFLOWD = resolve(process.env['RELAYFLOWD_BIN'] ?? locateRelayflowd());

function locateRelayflowd(): string {
  const direct = join(TOOLCHAIN_TARGET, 'debug', 'relayflowd');
  if (existsSync(direct)) return direct;
  const keyed = existsSync(TOOLCHAIN_TARGET)
    ? readdirSync(TOOLCHAIN_TARGET)
        .map((entry) => join(TOOLCHAIN_TARGET, entry, 'debug', 'relayflowd'))
        .filter((c) => existsSync(c))
        .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs)
    : [];
  if (keyed[0] !== undefined) return keyed[0];
  return join(ROOT, 'kernel', 'target', 'debug', 'relayflowd');
}

const temporaryDirectories: string[] = [];
const daemons: ChildProcess[] = [];
const clients: JournalClient[] = [];

beforeAll(() => {
  requireExecutable(RELAYFLOWD, 'RELAYFLOWD_BIN', '(cd kernel && ../ops/cargo.sh build)');
  console.log(`HN_E2E relayflowd=${RELAYFLOWD}`);
});

afterEach(async () => {
  for (const client of clients.splice(0)) client.close();
  for (const daemon of daemons.splice(0)) await stopDaemon(daemon);
  for (const dir of temporaryDirectories.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function requireExecutable(path: string, source: string, hint: string): void {
  try { accessSync(path, constants.X_OK); }
  catch { throw new Error(`HN_E2E_MISSING: ${source} does not name an executable file: ${path}. Build with: ${hint}`); }
}

function temporaryDirectory(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(dir);
  return dir;
}

async function startDaemon(dataDir: string): Promise<ChildProcess> {
  const daemon = spawn(RELAYFLOWD, ['--data-dir', dataDir, 'serve'], {
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemons.push(daemon);
  const stderr: Buffer[] = [];
  daemon.stderr?.on('data', (c: Buffer) => stderr.push(c));
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

async function stopDaemon(daemon: ChildProcess): Promise<void> {
  if (daemon.exitCode !== null || daemon.signalCode !== null) return;
  const exited = new Promise<void>((resolveExit) => daemon.once('exit', () => resolveExit()));
  daemon.kill('SIGTERM');
  await exited;
}

async function connectClient(dataDir: string): Promise<JournalClient> {
  const client = new JournalClient(join(dataDir, 'relayflowd.sock'), { requestTimeoutMs: 5_000 });
  clients.push(client);
  await client.connect();
  return client;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function eventOnce<T>(client: JournalClient, event: string): Promise<T> {
  return new Promise((resolveEvt) => client.once(event as any, resolveEvt));
}

/**
 * The flow spec used by the runner in these tests. `cli: echo` makes the
 * agent step deterministic — echo exits 0, so the worker journals a
 * `success` completionReason.
 */
function makeHnMonitorSpec(): unknown {
  return {
    name: 'hn-monitor',
    description: 'E2E test flow — echo-based agent step for deterministic completion.',
    version: '0.1.0',
    triggers: [
      {
        id: 'hn-story-posted',
        executor: 'agent-worker',
        event_type: 'hn.story_posted',
        pattern: { type: 'story' },
        dedupe_key_template: '{{event.type}}:{{payload.id}}',
      },
    ],
    steps: [
      {
        id: 'analyze',
        type: 'agent',
        cli: 'echo',
        instruction: 'analyze the story',
        recovery_mode: 'reset',
        depends_on: [],
        max_iterations: 1,
        retry: {
          initial_backoff_ms: 100,
          jitter_percent: 20,
          max_backoff_ms: 60000,
          multiplier: 2,
        },
      },
    ],
  };
}

describe('HnMonitorRunner end-to-end against a real relayflowd', () => {
  it('poll → journal → wake → dispatch → stepComplete completes a run', async () => {
    const dataDir = temporaryDirectory('hn-e2e-');
    await startDaemon(dataDir);

    // Attach a control client BEFORE the runner registers a subscription, so
    // we can observe the run from the outside.
    const control = await connectClient(dataDir);
    await control.hello('hn-e2e-control');

    // The runner constructs its own client + worker. Use a canned fetcher so
    // we submit exactly one story, deterministically.
    const spec = makeHnMonitorSpec();
    const controller = new AbortController();
    let firstDispatchSeen = false;
    let firstDispatchStepId: string | undefined;
    let firstDispatchRunId: string | undefined;

    // Observe the runner's worker for a step.dispatch. The runner constructs
    // its own AgentWorker so we don't have access to it directly — instead
    // observe by polling the control client's run listing after the fact.

    const runnerSocket = join(dataDir, 'relayflowd.sock');
    const runner = new HnMonitorRunner({
      spec,
      socketPath: runnerSocket,
      pollIntervalMs: 100,
      worker: {
        workerId: 'hn-e2e-runner-worker',
        pins: {
          workspace: [{ surface: 'repo', revision_id: 'rev-a' }],
          streams: [],
        } as any,
      },
      signal: controller.signal,
      fetcher: async () => JSON.stringify([88888888]),
      storyLimit: 1,
      maxPolls: 3, // give the loop enough ticks for the kernel to catch up
    });

    const runPromise = runner.run();

    // Wait for a run to appear + reach `done` — with a generous ceiling.
    const done = await Promise.race([
      pollUntilRunDone(control, 15_000),
      new Promise<null>((r) => setTimeout(() => r(null), 15_000)),
    ]);
    controller.abort();
    await runPromise;

    expect(done, 'a wake+dispatch+complete cycle must reach `done` within 15s').not.toBeNull();
    expect(done!.status).toBe('done');
    // The step's completion reason must be `success` (echo exited 0), not
    // `worker_error` or a park.
    const stepIds = Object.keys(done!.steps);
    expect(stepIds.length).toBeGreaterThan(0);
    const anyStep = done!.steps[stepIds[0]] as any;
    expect(anyStep.completion_reason ?? anyStep.completionReason).toBe('success');
  }, 30_000);
});

/**
 * Poll the control client until any run reaches `done`, or the deadline
 * elapses. Returns the RunGetResult or null.
 *
 * The control client doesn't have a "list runs" primitive — but the runner
 * submits with a deterministic dedupe key, so we look up recent runs by
 * subscribing to `run.spawned` events on this client and remembering the
 * first run_id we see, then polling runGet on it.
 */
async function pollUntilRunDone(client: JournalClient, timeoutMs: number): Promise<RunGetResult | null> {
  const deadline = Date.now() + timeoutMs;
  const runIdPromise = new Promise<string>((resolveRunId) => {
    const listener = (spawnedEvent: any): void => {
      const rid: string | undefined = spawnedEvent?.run_id ?? spawnedEvent?.runId;
      if (typeof rid === 'string') {
        client.off('run.spawned' as any, listener);
        resolveRunId(rid);
      }
    };
    client.on('run.spawned' as any, listener);
  });

  const runId = await Promise.race([
    runIdPromise,
    new Promise<null>((r) => setTimeout(() => r(null), timeoutMs)),
  ]);
  if (!runId) return null;

  while (Date.now() < deadline) {
    try {
      const result = await client.runGet(runId);
      if (result.status === 'done') return result;
      if (result.status === 'failed' || result.status === 'parked') {
        return result;
      }
    } catch { /* transient */ }
    await delay(200);
  }
  return null;
}
