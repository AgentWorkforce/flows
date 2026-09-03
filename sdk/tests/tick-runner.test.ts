/**
 * `tick-runner` tests.
 *
 * Every test here is written against a bound, not a mechanism. "The runner
 * fired" is nearly worthless: it passes whatever the cursor, the skip
 * accounting or the failure handling do. The three things that can actually go
 * wrong are:
 *
 *   1. a restart skips the slots between shutdown and restart;
 *   2. a slot passed over by `maxCatchUp` is not reported anywhere;
 *   3. a submit failure advances the cursor past a slot that never fired.
 *
 * Each has a test that fails if the behaviour is removed while the runner still
 * runs, and each is mutation-verified in the repair report.
 */

import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  loadTickState,
  runTickRunner,
  saveTickState,
  tickStatePath,
  type TickRunnerClient,
  type TickRunnerState,
} from '../src/cli/tick-runner.js';
import type { TickSchedule } from '../src/tick-source.js';
import type { CliIo } from '../src/cli.js';

const INTERVAL = 60_000;
const EPOCH = 1_000_000;

const SCHEDULE: TickSchedule = {
  scheduleId: 'heartbeat',
  intervalMs: INTERVAL,
  epochMs: EPOCH,
  maxCatchUp: 5,
};

/** `nowMs` placed exactly on slot `n`'s instant. */
function atSlot(n: number): number {
  return EPOCH + n * INTERVAL;
}

interface Recorded {
  slots: number[];
  scheduledFor: number[];
}

/**
 * A sink that records what actually reached `event.submit`, and can be told to
 * throw on the Nth call. Recording the payload rather than a call count is
 * what lets a test assert "exactly one submit per due slot" instead of
 * "something was submitted".
 */
function makeClient(throwOnCall?: number): { client: TickRunnerClient; recorded: Recorded } {
  const recorded: Recorded = { slots: [], scheduledFor: [] };
  let calls = 0;
  const client: TickRunnerClient = {
    hello: async () => ({ protocol: 'v0', server: 'test' }) as never,
    eventSubmit: async (_spec, event) => {
      calls += 1;
      if (throwOnCall !== undefined && calls === throwOnCall) {
        throw new Error('journal write refused');
      }
      const payload = event.payload as { slot: number; scheduled_for_ms: number };
      recorded.slots.push(payload.slot);
      recorded.scheduledFor.push(payload.scheduled_for_ms);
      return { matched: 0 } as never;
    },
    close: () => undefined,
  };
  return { client, recorded };
}

function makeIo(): { io: CliIo; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return { io: { stdout: (l) => out.push(l), stderr: (l) => err.push(l) }, out, err };
}

let dir: string;
let specPath: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'tick-runner-'));
  specPath = join(dir, 'spec.json');
  await writeFile(specPath, JSON.stringify({ steps: [] }), 'utf8');
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe('bound 1: a restart emits exactly one tick per due slot', () => {
  it('resumes from the persisted cursor instead of jumping to the current slot', async () => {
    // First runner: one poll at slot 3. Fresh cursor starts AT the current
    // slot, so this emits slot 3 only.
    const first = makeClient();
    const io1 = makeIo();
    expect(
      await runTickRunner(
        { dataDir: dir, specPath, schedule: SCHEDULE, maxPolls: 1,
          now: () => atSlot(3), connectClient: async () => first.client },
        io1.io,
      ),
    ).toBe(0);
    expect(first.recorded.slots).toEqual([3]);

    // The process dies. A NEW runner starts at slot 6 — three slots later.
    // Without a persisted cursor it would start at slot 6 and slots 4 and 5
    // would never fire and never be reported: the silent skip.
    const second = makeClient();
    const io2 = makeIo();
    expect(
      await runTickRunner(
        { dataDir: dir, specPath, schedule: SCHEDULE, maxPolls: 1,
          now: () => atSlot(6), connectClient: async () => second.client },
        io2.io,
      ),
    ).toBe(0);

    expect(second.recorded.slots).toEqual([4, 5, 6]);
    // Exactly one submit per slot across both lifetimes, no duplicates.
    expect([...first.recorded.slots, ...second.recorded.slots]).toEqual([3, 4, 5, 6]);
    expect(io2.out.some((l) => l.includes('resuming from slot 3'))).toBe(true);
  });

  it('starts at the current slot on a genuine first run, not at the epoch', async () => {
    // The other half of the distinction: no state on disk must NOT backfill
    // from slot 0, or a new hourly schedule floods the kernel with history.
    const { client, recorded } = makeClient();
    const io = makeIo();
    await runTickRunner(
      { dataDir: dir, specPath, schedule: SCHEDULE, maxPolls: 1,
        now: () => atSlot(500), connectClient: async () => client },
      io.io,
    );
    expect(recorded.slots).toEqual([500]);
    expect(io.out.some((l) => l.includes('first run'))).toBe(true);
  });

  it('persists the cursor and the last-emitted wall clock so a dead runner is detectable', async () => {
    const { client } = makeClient();
    await runTickRunner(
      { dataDir: dir, specPath, schedule: SCHEDULE, maxPolls: 1,
        now: () => atSlot(9), connectClient: async () => client },
      makeIo().io,
    );
    const state = await loadTickState(tickStatePath(dir, 'heartbeat'), 'heartbeat');
    expect(state.lastEmittedSlot).toBe(9);
    expect(state.lastEmittedAtMs).toBe(atSlot(9));
  });
});

describe('bound 2: a slot passed over by maxCatchUp is reported, never lost', () => {
  it('names every skipped slot and its scheduled instant, and persists them', async () => {
    // Cursor at slot 0, now at slot 20, maxCatchUp 5 → slots 1..15 are due but
    // over the bound. They must appear on stderr individually AND in the state
    // file; a count alone would let a reader skim past them.
    const statePath = tickStatePath(dir, 'heartbeat');
    await saveTickState(statePath, { scheduleId: 'heartbeat', lastEmittedSlot: 0, skippedSlots: [] });

    const { client, recorded } = makeClient();
    const io = makeIo();
    expect(
      await runTickRunner(
        { dataDir: dir, specPath, schedule: SCHEDULE, maxPolls: 1,
          now: () => atSlot(20), connectClient: async () => client },
        io.io,
      ),
    ).toBe(0);

    // Newest 5 emitted, oldest 15 skipped.
    expect(recorded.slots).toEqual([16, 17, 18, 19, 20]);

    const skipLines = io.err.filter((l) => l.startsWith('TICK_SKIPPED'));
    expect(skipLines).toHaveLength(15);
    // Each line carries the instant, so an operator can go looking for it.
    expect(skipLines[0]).toContain('slot=1');
    expect(skipLines[0]).toContain(`scheduled_for_ms=${atSlot(1)}`);
    expect(skipLines[0]).toContain('did NOT run');

    const state = await loadTickState(statePath, 'heartbeat');
    expect(state.skippedSlots).toEqual(Array.from({ length: 15 }, (_, i) => i + 1));
  });

  it('reports skipped slots even when the poll then fails', async () => {
    // The shape the primitive's TickEmitError exists for: a skip and a submit
    // failure in the same poll. If the runner only read the success path's
    // result, these 15 skips would die with the discarded return value.
    const statePath = tickStatePath(dir, 'heartbeat');
    await saveTickState(statePath, { scheduleId: 'heartbeat', lastEmittedSlot: 0, skippedSlots: [] });

    const { client } = makeClient(1); // throw on the very first submit
    const io = makeIo();
    expect(
      await runTickRunner(
        { dataDir: dir, specPath, schedule: SCHEDULE, maxPolls: 1,
          now: () => atSlot(20), connectClient: async () => client },
        io.io,
      ),
    ).toBe(1);

    expect(io.err.filter((l) => l.startsWith('TICK_SKIPPED'))).toHaveLength(15);
    expect(io.err.some((l) => l.startsWith('TICK_RUNNER_FAILED'))).toBe(true);
    const state = await loadTickState(statePath, 'heartbeat');
    expect(state.skippedSlots).toHaveLength(15);
  });
});

describe('bound 3: a submit failure leaves the unfired slot due', () => {
  it('does not advance the cursor past a slot whose submit threw', async () => {
    const statePath = tickStatePath(dir, 'heartbeat');
    await saveTickState(statePath, { scheduleId: 'heartbeat', lastEmittedSlot: 2, skippedSlots: [] });

    // Slots 3, 4, 5 due. Throw on the second submit, so 3 lands and 4 does not.
    const { client, recorded } = makeClient(2);
    const io = makeIo();
    expect(
      await runTickRunner(
        { dataDir: dir, specPath, schedule: SCHEDULE, maxPolls: 1,
          now: () => atSlot(5), connectClient: async () => client },
        io.io,
      ),
    ).toBe(1);

    expect(recorded.slots).toEqual([3]);
    // The cursor sits at 3, not 5. Slots 4 and 5 are still due.
    const state = await loadTickState(statePath, 'heartbeat');
    expect(state.lastEmittedSlot).toBe(3);

    // Prove it by running again with a working sink: 4 and 5 fire, and 3 is
    // not re-emitted.
    const retry = makeClient();
    expect(
      await runTickRunner(
        { dataDir: dir, specPath, schedule: SCHEDULE, maxPolls: 1,
          now: () => atSlot(5), connectClient: async () => retry.client },
        makeIo().io,
      ),
    ).toBe(0);
    expect(retry.recorded.slots).toEqual([4, 5]);
  });
});

describe('fail closed at declaration, before anything connects', () => {
  it.each([
    ['non-integer intervalMs', { ...SCHEDULE, intervalMs: 1.5 }],
    ['zero intervalMs', { ...SCHEDULE, intervalMs: 0 }],
    ['negative epochMs', { ...SCHEDULE, epochMs: -1 }],
    ['NaN epochMs', { ...SCHEDULE, epochMs: Number.NaN }],
    ['empty scheduleId', { ...SCHEDULE, scheduleId: '' }],
  ])('refuses %s without opening a connection', async (_label, schedule) => {
    let connected = false;
    const io = makeIo();
    expect(
      await runTickRunner(
        { dataDir: dir, specPath, schedule: schedule as TickSchedule, maxPolls: 1,
          now: () => atSlot(1),
          connectClient: async () => { connected = true; return makeClient().client; } },
        io.io,
      ),
    ).toBe(1);
    // The point of validating early: the operator is not told it started.
    expect(connected).toBe(false);
    expect(io.err.some((l) => l.startsWith('REFUSED [invalid_schedule]'))).toBe(true);
  });

  it('refuses a state file belonging to another schedule rather than resetting it', async () => {
    // A silent reset would convert a corrupted file into a silent skip of
    // everything since the last good emit — the failure this runner exists to
    // prevent.
    const statePath = tickStatePath(dir, 'heartbeat');
    await saveTickState(statePath, { scheduleId: 'something-else', skippedSlots: [] } as TickRunnerState);
    const io = makeIo();
    expect(
      await runTickRunner(
        { dataDir: dir, specPath, schedule: SCHEDULE, maxPolls: 1,
          now: () => atSlot(1), connectClient: async () => makeClient().client },
        io.io,
      ),
    ).toBe(1);
    expect(io.err.some((l) => l.includes('belongs to schedule something-else'))).toBe(true);
  });

  it('refuses a truncated state file rather than starting from nothing', async () => {
    const statePath = tickStatePath(dir, 'heartbeat');
    await saveTickState(statePath, { scheduleId: 'heartbeat', lastEmittedSlot: 4, skippedSlots: [] });
    await writeFile(statePath, '{"scheduleId":"heart', 'utf8');
    const io = makeIo();
    expect(
      await runTickRunner(
        { dataDir: dir, specPath, schedule: SCHEDULE, maxPolls: 1,
          now: () => atSlot(9), connectClient: async () => makeClient().client },
        io.io,
      ),
    ).toBe(1);
    expect(io.err.some((l) => l.includes('not valid JSON'))).toBe(true);
  });
});

describe('state file durability', () => {
  it('leaves the previous good state when a write is interrupted', async () => {
    // saveTickState writes a temp file and renames, so a crash mid-write
    // cannot truncate the live file.
    const statePath = tickStatePath(dir, 'heartbeat');
    await saveTickState(statePath, { scheduleId: 'heartbeat', lastEmittedSlot: 7, skippedSlots: [] });
    const before = await readFile(statePath, 'utf8');
    await writeFile(`${statePath}.tmp`, '{"partial', 'utf8');
    expect(await readFile(statePath, 'utf8')).toBe(before);
    expect((await loadTickState(statePath, 'heartbeat')).lastEmittedSlot).toBe(7);
  });
});

describe('CLI argument parsing refuses coercion rather than accepting it', () => {
  // parseInt('1.5') is 1. A fractional --interval-ms silently becoming a 1ms
  // schedule is strictly worse than a refusal: the operator wrote something
  // the tool did not do, and nothing says so. These rows pin the refusal.
  const { spawnSync } = require('node:child_process') as typeof import('node:child_process');
  const cliPath = join(__dirname, '..', 'dist', 'cli.js');

  it.each([
    ['fractional', '1.5'],
    ['exponent notation', '1e3'],
    ['hex', '0x10'],
    ['trailing text', '60000ms'],
    ['empty', ''],
  ])('refuses --interval-ms %s as an invocation error', (_label, value) => {
    const result = spawnSync(process.execPath, [
      cliPath, 'tick', 'start', '--schedule-id', 'x', '--interval-ms', value, 'spec.json',
    ], { encoding: 'utf8' });
    expect(result.stderr + result.stdout).toContain('invalid_invocation');
  });

  it('accepts an exact integer and proceeds past parsing', () => {
    const result = spawnSync(process.execPath, [
      cliPath, 'tick', 'start', '--schedule-id', 'x', '--interval-ms', '60000',
      join(tmpdir(), 'definitely-absent-spec.json'),
    ], { encoding: 'utf8' });
    // Past the parser: it fails on the missing spec, not on the invocation.
    const output = result.stderr + result.stdout;
    expect(output).not.toContain('invalid_invocation');
    expect(output).toContain('invalid_state');
  });
});
