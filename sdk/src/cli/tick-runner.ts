/**
 * `flows tick start` — drive a scheduled relayflow.
 *
 * A sibling of `hn-monitor.ts`, not a new species: a public function that
 * composes the primitives directly — connect journal → hello → loop
 * `emitDueTicks` → drain on abort → close. The differences from hn-monitor are
 * only the ones the grid forces.
 *
 * ## Why the cursor is persisted, and why that is the whole point
 *
 * `emitDueTicks` starts a FRESH cursor at the current slot:
 *
 *     const firstDue = cursor.lastEmittedSlot === undefined
 *       ? currentSlot
 *       : cursor.lastEmittedSlot + 1;
 *
 * That is right for a schedule's first ever poll — a new hourly schedule must
 * not backfill from the epoch. But it means an in-memory-only cursor makes a
 * restart SKIP every slot between shutdown and restart, silently. The dedupe
 * key `(schedule_id, scheduled_for_ms)` makes re-delivery of a slot harmless,
 * so a lost cursor cannot double-fire; nothing in the primitive protects
 * against the skip. The runner is where that is either handled or lost, so it
 * persists the cursor and reloads it on start.
 *
 * The distinction the file keeps: "no cursor on disk" means first run, start
 * at the current slot. "A cursor on disk behind the grid" means catch up, and
 * report anything past `maxCatchUp` as skipped. Conflating the two either
 * backfills a new schedule from 1970 or silently drops a restart's arrears.
 *
 * ## Why a skip must reach the operator
 *
 * `skippedSlots` and `TickEmitError` exist because a skip that is only a
 * return value is a skip that a `throw` can discard. `emitDueTicks` guarantees
 * the accounting survives its own failure; this runner is the consumer that
 * makes it visible. A skipped slot is real scheduled work that did not run.
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { JournalClient } from '../journal-client.js';
import {
  DEFAULT_MAX_CATCH_UP,
  TickEmitError,
  assertTickScheduleValid,
  emitDueTicks,
  scheduledForMs,
  slotFor,
  type TickCursor,
  type TickEmitResult,
  type TickSchedule,
} from '../tick-source.js';
import type { EventSubmitResult, HelloResult } from '../protocol.js';
import type { CliIo } from '../cli.js';
import { sleepInterruptible } from './interruptible-sleep.js';

/** How often to look for due slots when the caller does not say. */
const DEFAULT_POLL_INTERVAL_MS = 15_000;

/**
 * Minimum client surface the runner uses. Concrete protocol return types
 * rather than `unknown`, so a rename in the journal protocol fails to compile
 * here instead of drifting silently past the interface — the same reason
 * `HnMonitorClient` is shaped this way.
 */
export interface TickRunnerClient {
  hello(client: string): Promise<HelloResult>;
  eventSubmit(
    spec: unknown,
    event: { type: string; payload?: unknown; key?: string },
  ): Promise<EventSubmitResult>;
  close(): void;
}

/** Where the runner's durable cursor lives, and what it holds. */
export interface TickRunnerState {
  scheduleId: string;
  /** Mirror of `TickCursor.lastEmittedSlot`. Absent before the first emit. */
  lastEmittedSlot?: number;
  /**
   * Wall clock of the last successful submit. Not used for scheduling — the
   * grid owns that — but it is what makes a dead runner detectable, so
   * `staleAfterMs` means something end to end rather than only inside the
   * kernel's own sweep.
   */
  lastEmittedAtMs?: number;
  /** Every slot ever passed over, oldest first. Append-only. */
  skippedSlots: number[];
}

interface TickRunnerArgsBase {
  /** Data directory containing `relayflowd.sock`. Required. */
  dataDir: string;
  /** Absolute path to the canonical flow spec JSON. Required. */
  specPath: string;
  /** The grid. Validated at declaration, before anything connects. */
  schedule: TickSchedule;
  /** How often to look for due slots. Default 15000ms. */
  pollIntervalMs?: number;
  /**
   * Where to persist the cursor. Defaults to
   * `<dataDir>/tick-state/<scheduleId>.json`.
   */
  statePath?: string;
  /**
   * Cap on poll iterations. Undefined = unbounded (production). 0 means
   * "connect, poll zero times, drain, exit 0" — used by tests that only need
   * the setup and teardown paths.
   */
  maxPolls?: number;
  /** AbortSignal for external cancellation (tests, SIGINT wiring). */
  signal?: AbortSignal;
  /** Injectable clock so tests can place `now` on the grid deliberately. */
  now?: () => number;
}

/**
 * Test injection surface. `connectClient` is supplied alone here — unlike
 * hn-monitor, this runner attaches no worker, so there is no pairing to
 * enforce: a tick is submitted through `event.submit` and the kernel dispatches
 * to whatever worker the flow's trigger names.
 */
export interface TickRunnerArgs extends TickRunnerArgsBase {
  /**
   * Async, because a real `JournalClient` needs `connect()` before `hello()`.
   * A synchronous injection surface hid that: the unit tests' fake client has
   * no transport, so it connected vacuously and the missing `connect()` only
   * surfaced against a live daemon with `journal client: not connected
   * (hello)`. The default path below owns connect+hello so no caller can
   * forget half of it.
   */
  connectClient?: (socketPath: string) => Promise<TickRunnerClient>;
}

/** Connect and handshake. Both steps, or neither. */
async function defaultConnectClient(socketPath: string): Promise<TickRunnerClient> {
  const client = new JournalClient(socketPath);
  await client.connect();
  await client.hello('flows-tick-runner');
  return client;
}

/** Absolute path to the state file for one schedule. */
export function tickStatePath(dataDir: string, scheduleId: string): string {
  return join(dataDir, 'tick-state', `${encodeURIComponent(scheduleId)}.json`);
}

/**
 * Load the durable cursor, distinguishing "no state" from "state behind the
 * grid". A missing file is a first run and must start at the current slot; a
 * present file must be honoured however far behind it is, so the arrears are
 * either caught up or reported.
 *
 * A malformed or foreign-schedule state file is a hard error rather than a
 * silent reset: resetting would convert an operator's corrupted file into a
 * silent skip of everything since the last good emit, which is the failure
 * this runner exists to prevent.
 */
export async function loadTickState(
  path: string,
  scheduleId: string,
): Promise<TickRunnerState> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (cause) {
    if ((cause as { code?: string }).code === 'ENOENT') {
      return { scheduleId, skippedSlots: [] };
    }
    throw cause;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`tick state at ${path} is not valid JSON`, { cause });
  }
  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error(`tick state at ${path} is not an object`);
  }
  const state = parsed as Partial<TickRunnerState>;
  if (state.scheduleId !== scheduleId) {
    throw new Error(
      `tick state at ${path} belongs to schedule ${String(state.scheduleId)}, not ${scheduleId}`,
    );
  }
  if (state.lastEmittedSlot !== undefined && !Number.isInteger(state.lastEmittedSlot)) {
    throw new Error(`tick state at ${path} has a non-integer lastEmittedSlot`);
  }
  // Fail closed rather than coerce. `Array.isArray(...) ? ... : []` silently
  // turned a malformed value into "no slots were skipped" — which is the exact
  // claim this runner exists to make trustworthy. A state file that cannot say
  // what it missed must stop the runner, not quietly report that it missed
  // nothing.
  if (state.skippedSlots !== undefined && !Array.isArray(state.skippedSlots)) {
    throw new Error(`tick state at ${path} has a non-array skippedSlots`);
  }
  if (state.skippedSlots?.some((slot) => !Number.isInteger(slot))) {
    throw new Error(`tick state at ${path} has a non-integer entry in skippedSlots`);
  }
  return {
    scheduleId,
    ...(state.lastEmittedSlot === undefined ? {} : { lastEmittedSlot: state.lastEmittedSlot }),
    ...(state.lastEmittedAtMs === undefined ? {} : { lastEmittedAtMs: state.lastEmittedAtMs }),
    skippedSlots: state.skippedSlots ?? [],
  };
}

/**
 * Persist the cursor. Written to a temp file and renamed, so a crash mid-write
 * leaves the previous good state rather than a truncated file — a truncated
 * file would be a hard error on next start, which is safe but needlessly
 * blocks a runner that had a perfectly good cursor a moment earlier.
 */
export async function saveTickState(path: string, state: TickRunnerState): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temp = `${path}.tmp`;
  await writeFile(temp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
  const { rename } = await import('node:fs/promises');
  await rename(temp, path);
}

/** One poll's accounting, for logging and for tests to assert on. */
export interface TickPollReport {
  emittedSlots: number[];
  skippedSlots: number[];
  /** Set when the poll threw. The partial accounting is still present. */
  failure?: unknown;
}

/**
 * Run `flows tick start`. Returns 0 on clean shutdown, 1 on a fatal error.
 *
 * Fatal means: the schedule is invalid, the state file is unreadable or
 * belongs to another schedule, the journal cannot be reached, or a submit
 * failed. A submit failure is fatal by design — `emitDueTicks` leaves the slot
 * due, so retrying is the next poll's job, but a runner that swallows journal
 * failures and keeps looping is the silent-zero this is meant to prevent.
 */
export async function runTickRunner(args: TickRunnerArgs, io: CliIo): Promise<number> {
  const now = args.now ?? Date.now;
  const pollIntervalMs = args.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;

  // Refuse a bad grid BEFORE connecting. A runner that attaches and only then
  // discovers `--interval-ms` was 1.5 has already told the operator it started.
  try {
    assertTickScheduleValid(args.schedule, now());
  } catch (cause) {
    io.stderr(`REFUSED [invalid_schedule] ${(cause as Error).message}`);
    return 1;
  }
  if (!Number.isInteger(pollIntervalMs) || pollIntervalMs <= 0) {
    io.stderr('REFUSED [invalid_schedule] pollIntervalMs must be a positive integer');
    return 1;
  }

  const specPath = isAbsolute(args.specPath) ? args.specPath : resolve(args.specPath);
  const statePath = args.statePath ?? tickStatePath(args.dataDir, args.schedule.scheduleId);

  let spec: unknown;
  let state: TickRunnerState;
  try {
    spec = JSON.parse(await readFile(specPath, 'utf8'));
    state = await loadTickState(statePath, args.schedule.scheduleId);
  } catch (cause) {
    io.stderr(`REFUSED [invalid_state] ${(cause as Error).message}`);
    return 1;
  }

  const resuming = state.lastEmittedSlot !== undefined;
  const cursor: TickCursor = resuming ? { lastEmittedSlot: state.lastEmittedSlot } : {};

  const socketPath = join(args.dataDir, 'relayflowd.sock');
  let client: TickRunnerClient;
  try {
    client = args.connectClient
      ? await args.connectClient(socketPath)
      : await defaultConnectClient(socketPath);
  } catch (cause) {
    io.stderr(`TICK_RUNNER_FAILED ${(cause as Error).constructor.name}: ${(cause as Error).message}`);
    return 1;
  }

  let exitCode = 0;
  try {
    const startSlot = slotFor(args.schedule, now());
    io.stdout(
      resuming
        ? `TICK_RUNNER schedule=${args.schedule.scheduleId} resuming from slot ${String(state.lastEmittedSlot)}; current slot ${startSlot}`
        : `TICK_RUNNER schedule=${args.schedule.scheduleId} first run; starting at slot ${startSlot}`,
    );

    let polls = 0;
    while (!(args.signal?.aborted ?? false)) {
      if (args.maxPolls !== undefined && polls >= args.maxPolls) break;
      polls += 1;

      const report = await pollOnce(spec, client, args.schedule, cursor, now());

      // Persist before reporting. The cursor is the thing a restart depends
      // on; losing it costs slots, whereas losing a log line costs a message.
      if (report.emittedSlots.length > 0) {
        state.lastEmittedSlot = cursor.lastEmittedSlot;
        state.lastEmittedAtMs = now();
      }
      if (report.skippedSlots.length > 0) {
        state.skippedSlots.push(...report.skippedSlots);
      }
      if (report.emittedSlots.length > 0 || report.skippedSlots.length > 0) {
        await saveTickState(statePath, state);
      }

      for (const slot of report.skippedSlots) {
        // Loud, per slot, with the instant it stood for. A count would let a
        // reader skim past "3 skipped"; an instant is a thing an operator can
        // go and look for in the journal and fail to find.
        io.stderr(
          `TICK_SKIPPED schedule=${args.schedule.scheduleId} slot=${slot} scheduled_for_ms=${scheduledForMs(args.schedule, slot)} — past maxCatchUp=${args.schedule.maxCatchUp ?? DEFAULT_MAX_CATCH_UP}; this scheduled work did NOT run`,
        );
      }
      for (const slot of report.emittedSlots) {
        io.stdout(
          `TICK_EMITTED schedule=${args.schedule.scheduleId} slot=${slot} scheduled_for_ms=${scheduledForMs(args.schedule, slot)}`,
        );
      }

      if (report.failure !== undefined) {
        const failure = report.failure;
        const name = failure instanceof Error ? failure.constructor.name : typeof failure;
        const message = failure instanceof Error ? failure.message : String(failure);
        io.stderr(`TICK_RUNNER_FAILED ${name}: ${message}`);
        return 1;
      }

      if (args.signal?.aborted ?? false) break;
      if (args.maxPolls !== undefined && polls >= args.maxPolls) break;
      await sleepInterruptible(pollIntervalMs, args.signal);
    }
    io.stdout(`TICK_RUNNER_STOPPED schedule=${args.schedule.scheduleId} polls=${polls}`);
  } catch (cause) {
    const name = cause instanceof Error ? cause.constructor.name : typeof cause;
    io.stderr(`TICK_RUNNER_FAILED ${name}: ${(cause as Error).message}`);
    exitCode = 1;
  } finally {
    client.close();
  }
  return exitCode;
}

/**
 * One poll. Normalises the two shapes `emitDueTicks` can produce — a result,
 * or a `TickEmitError` carrying the partial result — into one report, so the
 * caller has exactly one accounting path and cannot handle the success case
 * and forget the failure case.
 */
async function pollOnce(
  spec: unknown,
  sink: TickRunnerClient,
  schedule: TickSchedule,
  cursor: TickCursor,
  nowMs: number,
): Promise<TickPollReport> {
  try {
    const result: TickEmitResult = await emitDueTicks(spec, sink, { schedule, cursor, nowMs });
    return { emittedSlots: result.emittedSlots, skippedSlots: result.skippedSlots };
  } catch (cause) {
    if (cause instanceof TickEmitError) {
      // The partial accounting travelled with the failure. Surface it, then
      // let the caller treat the failure as fatal — the unemitted slots are
      // still due, because `emitDueTicks` only advances on success.
      return {
        emittedSlots: cause.emittedSlots,
        skippedSlots: cause.skippedSlots,
        failure: cause.cause ?? cause,
      };
    }
    return { emittedSlots: [], skippedSlots: [], failure: cause };
  }
}
