import { EventEmitter } from 'node:events';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { JournalClient } from '../src/journal-client.js';
import type { Pins } from '../src/protocol.js';
import { AgentWorker } from '../src/worker.js';
import { runAgentCli } from '../src/worker-cli.js';

/**
 * A `relayflows-agent-cli-v1` wrapper used to get five minutes to do agent
 * work, while a native `claude` or `codex` step got no duration bound at all
 * (`adapters/*.ts` pin `timeoutMs: 0`). Nothing in the product ever passed
 * `wrapperLimits`, so the constant was unreachable: every real agent step on
 * the wrapper path died at 300 s.
 *
 * These are parity tests, and parity is the whole claim. Neither path gains a
 * hard wall-clock bound here — what stops an unbounded wrapper is the lease
 * abort, exactly as for a native CLI. The flow's `max_wallclock_ms` drains
 * rather than cancelling a running step (`kernel/relayflowd-core/src/machine.rs`),
 * and implementing hard budget cancellation is separate, unresolved scope.
 */

const directories: string[] = [];
/** Undoes `watchHandshakeDeadline` even if an assertion threw before its own `finally`. */
let restoreClock: (() => void) | undefined;

afterEach(() => {
  restoreClock?.();
  restoreClock = undefined;
  vi.useRealTimers();
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'flows-wrapper-duration-'));
  directories.push(directory);
  return directory;
}

/**
 * A conforming wrapper that acknowledges, then works until the test releases
 * it. Its own poll runs in its own process on the real clock, so the parent's
 * fake clock is the only thing the advance below moves.
 */
function makeHeldWrapper(directory: string, name: string, payload: string): { wrapper: string; release: () => void } {
  const go = join(directory, `${name}.go`);
  const wrapper = join(directory, name);
  writeFileSync(wrapper, `#!/usr/bin/env node
const { existsSync } = require('node:fs');
process.stdout.write('relayflows-agent-cli-v1\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
  const poll = setInterval(() => {
    if (!existsSync(${JSON.stringify(go)})) return;
    clearInterval(poll);
    process.stdout.write(${JSON.stringify(payload)});
    process.exit(0);
  }, 20);
});
`);
  chmodSync(wrapper, 0o755);
  return { wrapper, release: () => writeFileSync(go, 'go') };
}

/** The default handshake deadline, which is what identifies that timer below. */
const HANDSHAKE_DEFAULT_MS = 10_000;

/**
 * Parent-side evidence that the worker has consumed the execute
 * acknowledgement and left the handshake.
 *
 * A sentinel written by the wrapper proves only that the wrapper wrote the
 * token, not that this process read it — and reading it is the event the
 * execution phase begins on. So watch the one thing the parent does at that
 * moment and at no other: it clears the handshake deadline. That is observable
 * whether or not an execution deadline replaces it, so this synchronization
 * behaves identically on the fixed and the unfixed code, and the clock is
 * never advanced while the 10 s handshake timer could still fire and turn the
 * duration regression into a handshake refusal.
 */
function watchHandshakeDeadline(): { acknowledged: () => boolean } {
  const armTimer = globalThis.setTimeout;
  const clearArmed = globalThis.clearTimeout;
  // Every candidate, not just the first: `withWorkerLease` renews at a third
  // of a 30 s lease, which is also 10 000 ms, and it arms that timer BEFORE
  // the spawn. Latching one handle would latch that one. A renewal timer is
  // only ever cleared after the CLI has already returned, so "any candidate
  // cleared" still names the handshake in every test here.
  const candidates = new Set<unknown>();
  let acknowledged = false;
  globalThis.setTimeout = ((handler: () => void, delay?: number, ...rest: unknown[]) => {
    const handle = (armTimer as (...args: unknown[]) => unknown)(handler, delay, ...rest);
    if (delay === HANDSHAKE_DEFAULT_MS) candidates.add(handle);
    return handle;
  }) as unknown as typeof globalThis.setTimeout;
  globalThis.clearTimeout = ((handle?: unknown) => {
    if (candidates.has(handle)) acknowledged = true;
    return (clearArmed as (...args: unknown[]) => unknown)(handle);
  }) as unknown as typeof globalThis.clearTimeout;
  // Put back exactly what was replaced. Leaving the wrapper installed would
  // let the NEXT `useFakeTimers` record it as the "real" timer and restore a
  // closure over an uninstalled fake, which is how a later test loses
  // `setTimeout` entirely.
  restoreClock = () => { globalThis.setTimeout = armTimer; globalThis.clearTimeout = clearArmed; };
  return { acknowledged: () => acknowledged };
}

/** Real-clock poll: `shouldAdvanceTime` keeps the fake timer moving on its own. */
async function untilAcknowledged(watch: { acknowledged: () => boolean }): Promise<void> {
  const wait = setTimeout;
  const deadline = Date.now() + 10_000;
  while (!watch.acknowledged() && Date.now() < deadline) {
    await new Promise(resume => wait(resume, 10));
  }
  expect(watch.acknowledged(), 'the worker never consumed the execute acknowledgement').toBe(true);
}

it('lets a wrapper work past the former 300 s cap at default limits', async () => {
  const directory = makeDirectory();
  const held = makeHeldWrapper(directory, 'long-wrapper', '{"ok":"past-the-cap"}');
  // Only `setTimeout`/`clearTimeout` are faked: the wrapper is a real process
  // doing real I/O, and `shouldAdvanceTime` keeps this side's own waits real.
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
  const watch = watchHandshakeDeadline();
  try {
    // No `wrapperLimits`, which is the only configuration the product reaches:
    // `worker.ts` and `llm-worker.ts` both pass `undefined`.
    const running = runAgentCli(
      held.wrapper, 'instruction', undefined, undefined, undefined, undefined, 'agent', undefined, directory,
    );
    await untilAcknowledged(watch);
    await vi.advanceTimersByTimeAsync(600_000);
    held.release();
    const result = await running;
    expect(result.stderr_tail).toBe('');
    expect(result.exit_code).toBe(0);
    expect(result.stdout_tail).toBe('{"ok":"past-the-cap"}');
  } finally {
    held.release();
    restoreClock?.(); restoreClock = undefined;
    vi.useRealTimers();
  }
}, 60_000);

it('lets a lease-bound wrapper work past the former 300 s cap', async () => {
  const directory = makeDirectory();
  const held = makeHeldWrapper(directory, 'long-leased-wrapper', '{"ok":"leased"}');
  const controller = new AbortController();
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
  const watch = watchHandshakeDeadline();
  let running: Promise<unknown> | undefined;
  try {
    // A never-aborted signal is what a held lease looks like, and it is also
    // what asks the spawn for a process group of its own.
    running = runAgentCli(
      held.wrapper, 'instruction', undefined, undefined, undefined, controller.signal, 'agent', undefined, directory,
    );
    await untilAcknowledged(watch);
    await vi.advanceTimersByTimeAsync(600_000);
    held.release();
    const result = await running as { exit_code: number | null; stdout_tail: string; stderr_tail: string };
    expect(result.stderr_tail).toBe('');
    expect(result.exit_code).toBe(0);
    expect(result.stdout_tail).toBe('{"ok":"leased"}');
  } finally {
    held.release();
    if (!controller.signal.aborted) controller.abort();
    restoreClock?.(); restoreClock = undefined;
    vi.useRealTimers();
    await running?.catch(() => undefined);
  }
}, 60_000);

it('lets a wrapper-backed llm step work past the former 300 s cap', async () => {
  const directory = makeDirectory();
  const held = makeHeldWrapper(directory, 'long-llm-wrapper', 'llm answer past the cap');
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
  const watch = watchHandshakeDeadline();
  try {
    // Both production workers share this session, and `llm-worker.ts` passes
    // no limits either, so the default reaches that path unchanged.
    const running = runAgentCli(held.wrapper, 'prompt', undefined, undefined, undefined, undefined, 'llm');
    await untilAcknowledged(watch);
    await vi.advanceTimersByTimeAsync(600_000);
    held.release();
    const result = await running;
    expect(result.stderr_tail).toBe('');
    expect(result.exit_code).toBe(0);
    expect(result.stdout_tail).toBe('llm answer past the cap');
  } finally {
    held.release();
    restoreClock?.(); restoreClock = undefined;
    vi.useRealTimers();
  }
}, 60_000);

it('completes an agent step exactly once when a wrapper outlives the former cap under a renewing lease', async () => {
  const directory = makeDirectory();
  const held = makeHeldWrapper(directory, 'long-step-wrapper', '{"ok":"stepped"}');
  // `Date` is faked here too, so the lease clock and the timer clock advance
  // together: `withWorkerLease` renews at a third of the remaining lease and
  // then re-reads `Date.now()` before permitting completion, and the two must
  // agree or a 600 s advance would expire a lease that was being renewed.
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const watch = watchHandshakeDeadline();
  const completions: unknown[][] = [];
  const heartbeats: number[] = [];
  const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
  client.workerAttach = async (): Promise<unknown> => ({ ok: true });
  client.stepHeartbeat = async (): Promise<unknown> => {
    heartbeats.push(Date.now());
    return { lease_deadline_ms: Date.now() + 30_000 };
  };
  client.stepComplete = async (...args: unknown[]): Promise<unknown> => {
    completions.push(args);
    return { ok: true };
  };
  const worker = new AgentWorker(client as unknown as JournalClient, { workerId: 'w-long', pins: {} as Pins });
  const workerErrors: unknown[] = [];
  worker.on('error', (error: unknown) => { workerErrors.push(error); });
  try {
    await worker.attach();
    client.emit('step.dispatch', {
      run_id: 'run-long', step_id: 'step-long', attempt: 1, step_type: 'agent',
      spec: { cli: held.wrapper, instruction: 'instruction', cwd: directory },
      lease_id: 'lease-long', lease_deadline_ms: Date.now() + 30_000,
      idempotency_key: 'idem-long', pins: {} as Pins,
    });
    await untilAcknowledged(watch);
    await vi.advanceTimersByTimeAsync(600_000);
    held.release();
    await worker.close();
  } finally {
    held.release();
    restoreClock?.(); restoreClock = undefined;
    vi.useRealTimers();
  }

  expect(workerErrors).toEqual([]);
  expect(completions).toHaveLength(1);
  // Argument 5 is `completionReason` in JournalClient.stepComplete.
  expect(completions[0]?.[4]).toBe('success');
  // The lease was held across the advance by renewal, not by a long deadline.
  expect(heartbeats.length).toBeGreaterThan(1);
}, 60_000);

it('treats an explicit executionTimeoutMs of 0 as no deadline, not as the old fallback', async () => {
  const directory = makeDirectory();
  const held = makeHeldWrapper(directory, 'zero-wrapper', '{"ok":"zero"}');
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
  const watch = watchHandshakeDeadline();
  try {
    // `positiveLimit` used to coerce `0` back to 300 000, so a short test could
    // not tell "no deadline" from "the default deadline". Only an advance past
    // the old fallback can.
    const running = runAgentCli(
      held.wrapper, 'instruction', undefined, undefined, { executionTimeoutMs: 0 },
      undefined, 'agent', undefined, directory,
    );
    await untilAcknowledged(watch);
    await vi.advanceTimersByTimeAsync(600_000);
    held.release();
    const result = await running;
    expect(result.stderr_tail).toBe('');
    expect(result.exit_code).toBe(0);
    expect(result.stdout_tail).toBe('{"ok":"zero"}');
  } finally {
    held.release();
    restoreClock?.(); restoreClock = undefined;
    vi.useRealTimers();
  }
}, 60_000);

it('keeps the handshake deadline independent of the removed execution deadline', async () => {
  const directory = makeDirectory();
  const wrapper = join(directory, 'mute-wrapper');
  // Identifies never, so the 10 s handshake liveness check is the only bound
  // that can apply. Removing the execution deadline must not remove this one.
  writeFileSync(wrapper, `#!/usr/bin/env node
setInterval(() => {}, 1000);
`);
  chmodSync(wrapper, 0o755);
  vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const running = runAgentCli(
      wrapper, 'instruction', undefined, undefined, undefined, undefined, 'agent', undefined, directory,
    );
    await vi.advanceTimersByTimeAsync(HANDSHAKE_DEFAULT_MS + 2_500);
    const result = await running;
    expect(result.exit_code).toBeNull();
    expect(result.stderr_tail).toMatch(/did not identify as relayflows-agent-cli-v1 within 10000ms/i);
  } finally {
    restoreClock?.(); restoreClock = undefined;
    vi.useRealTimers();
  }
}, 60_000);

it('still lets a lease abort stop an unlimited wrapper before it produces output', async () => {
  const directory = makeDirectory();
  const held = makeHeldWrapper(directory, 'abortable-wrapper', '{"mustNotBeReported":true}');
  const controller = new AbortController();
  let running: Promise<unknown> | undefined;
  try {
    running = runAgentCli(
      held.wrapper, 'instruction', undefined, undefined, undefined, controller.signal, 'agent', undefined, directory,
    );
    // Give the handshake real time to complete, then take the lease away. With
    // no execution deadline this abort is what bounds the step — the same
    // escape hatch a native `codex` step has, and the only one either has.
    await new Promise(wait => setTimeout(wait, 500));
    controller.abort(new Error('lease rejected'));
    const result = await running as { exit_code: number | null; stdout_tail: string; stderr_tail: string };
    expect(result.exit_code).toBeNull();
    expect(result.stdout_tail).toBe('');
    expect(result.stderr_tail).toBe('Agent execution aborted: lease ownership lost.');
  } finally {
    held.release();
    if (!controller.signal.aborted) controller.abort();
    // An assertion above can leave this pending; an unobserved rejection would
    // be reported against whichever test happens to run next.
    await running?.catch(() => undefined);
  }
}, 30_000);
