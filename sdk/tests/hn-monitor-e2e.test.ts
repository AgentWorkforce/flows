/**
 * End-to-end integration test for the gate 2 primitives against a live
 * relayflowd. This is the workload-actually-runs proof gate 2 requires
 * (RFC-0001 §3 rule 2).
 *
 * Deliberately exercises the primitives DIRECTLY rather than through
 * HnMonitorRunner — HnMonitorRunner is glue over these primitives, so
 * proving they compose end-to-end IS the gate 2 proof for the runner too.
 * Testing via the runner introduces a runId-observation problem the
 * relayflowd wire protocol doesn't cleanly support (there is no global
 * `run.spawned` event on ordinary connections — only clients that
 * `runWatch(runId)` get journal entries for that run).
 *
 * The flow used here uses `cli: echo` so the agent step completes
 * deterministically (echo exits 0 -> `success` completion reason). No
 * external network, no LLM.
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
import type { EventSubmitResult } from '../src/protocol.js';

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

/**
 * Flow spec used by the e2e. `cli: echo` -> deterministic completion.
 * Trigger on `hn.story_posted` matching `{ type: 'story' }` (same shape
 * the runner submits).
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

describe('gate-2 primitives against a real relayflowd', () => {
  it('event.submit -> kernel wakes run -> AgentWorker completes step -> run reaches done', async () => {
    const dataDir = temporaryDirectory('hn-e2e-');
    await startDaemon(dataDir);

    // Attach a worker BEFORE submitting — the live-kernel suite pins this
    // contract (a run parked because no worker attached is only revived by
    // run.resume).
    const workerClient = await connectClient(dataDir);
    await workerClient.hello('hn-e2e-worker');
    const worker = new AgentWorker(workerClient, {
      workerId: 'hn-e2e-worker',
      pins: {
        workspace: [{ surface: 'repo', revision_id: 'rev-a' }],
        streams: [],
      } as any,
    });
    await worker.attach();

    // Separate submitter client — its eventSubmit result gives us the runId
    // to watch. Ordinary connections do NOT receive a global run.spawned
    // event; run.watch(runId) is the only way to observe entries for a run.
    const submitter = await connectClient(dataDir);
    await submitter.hello('hn-e2e-submitter');
    const spec = makeHnMonitorSpec();
    const submitResult: EventSubmitResult = await submitter.eventSubmit(spec, {
      type: 'hn.story_posted',
      payload: { id: 88888888, type: 'story' },
    });
    expect(submitResult.matched, 'submitted event must match a trigger').toBe(true);
    // The kernel returns the run it woke (spawned or resumed).
    const runInfo = submitResult.run as any;
    const runId: string | undefined = runInfo?.run_id ?? runInfo?.runId;
    expect(runId, 'event.submit result must carry a run reference').toBeDefined();

    // Now poll runGet until done — the worker's runCli(echo) call takes a
    // handful of ms; giving a generous ceiling for cold-CI kernels.
    const deadline = Date.now() + 15_000;
    let lastStatus: string | undefined;
    let finalRun: Awaited<ReturnType<JournalClient['runGet']>> | undefined;
    while (Date.now() < deadline) {
      const result = await submitter.runGet(runId!);
      lastStatus = result.status;
      if (result.status === 'done' || result.status === 'failed' || result.status === 'parked') {
        finalRun = result;
        break;
      }
      await delay(200);
    }
    // Clean shutdown proves the drain path too.
    await worker.close();

    expect(finalRun, `run ${runId} must terminate within 15s (last status: ${lastStatus})`).toBeDefined();
    expect(finalRun!.status).toBe('done');

    // Assert the single step completed with `success` (echo exit 0). Kernel
    // step shape varies between wire versions; check either casing.
    const stepIds = Object.keys(finalRun!.steps);
    expect(stepIds.length).toBeGreaterThan(0);
    const step = finalRun!.steps[stepIds[0]] as any;
    const reason: string | undefined = step.completion_reason ?? step.completionReason;
    expect(reason, `first step completion_reason should be success, got ${reason}`).toBe('success');
  }, 30_000);
});
