import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  DEFAULT_MAX_CATCH_UP,
  TICK_DEDUPE_KEY_TEMPLATE,
  TICK_EVENT_TYPE,
  emitDueTicks,
  scheduledForMs,
  slotFor,
  tickDedupeKey,
  TickEmitError,
  type TickCursor,
  type TickPayload,
  type TickSchedule,
} from '../src/tick-source.js';
import { compileYaml, toKernelSpec } from '../src/compile.js';

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testdata');

/**
 * Stands in for the kernel's `(flow_key, subscription_id, dedupe_key)` claim.
 * `tests/live-kernel.test.ts` proves the real kernel behaves this way; this
 * fake lets the bound tests below run without a daemon.
 */
function dedupingSink(schedule: TickSchedule) {
  const claimed = new Set<string>();
  const runs: TickPayload[] = [];
  const submitted: TickPayload[] = [];
  return {
    runs,
    submitted,
    claimed,
    async eventSubmit(_spec: unknown, event: { type: string; payload?: unknown }) {
      const payload = event.payload as TickPayload;
      submitted.push(payload);
      const key = `${event.type}:${payload.schedule_id}:${payload.scheduled_for_ms}`;
      // Cross-check: the key the kernel would derive from the flow's declared
      // template must equal the one this source claims it derives.
      expect(key).toBe(tickDedupeKey(schedule, payload.slot));
      if (claimed.has(key)) return { matched: true, deduped: true };
      claimed.add(key);
      runs.push(payload);
      return { matched: true, deduped: false };
    },
  };
}

const MINUTE = 60_000;
const schedule = (over: Partial<TickSchedule> = {}): TickSchedule => ({
  scheduleId: 'heartbeat-1m',
  intervalMs: MINUTE,
  epochMs: 0,
  ...over,
});

describe('tick source: the slot grid', () => {
  it('derives the scheduled instant from the grid, NOT from the emit time', async () => {
    // The bound: a tick emitted 37s into its slot must still carry the slot's
    // boundary. If `scheduled_for_ms` tracked wall clock, this fails.
    const s = schedule();
    const sink = dedupingSink(s);
    const cursor: TickCursor = { lastEmittedSlot: 99 };

    await emitDueTicks({}, sink, { schedule: s, cursor, nowMs: 100 * MINUTE + 37_000 });

    expect(sink.submitted).toHaveLength(1);
    expect(sink.submitted[0]!.slot).toBe(100);
    expect(sink.submitted[0]!.scheduled_for_ms).toBe(100 * MINUTE);
    expect(sink.submitted[0]!.emitted_at_ms).toBe(100 * MINUTE + 37_000);
    expect(sink.submitted[0]!.lag_ms).toBe(37_000);
  });

  it('anchors slots at epochMs so the grid is a declared choice', () => {
    const anchored = schedule({ epochMs: 30_000 });
    expect(slotFor(anchored, 30_000)).toBe(0);
    expect(slotFor(anchored, 89_999)).toBe(0);
    expect(slotFor(anchored, 90_000)).toBe(1);
    expect(scheduledForMs(anchored, 5)).toBe(30_000 + 5 * MINUTE);
  });
});

describe('tick source: a double-fire produces ONE run', () => {
  it('two emissions of one scheduled instant claim the same key, so one run', async () => {
    // The gate. "A tick fired" proves nothing; this is the real bound.
    const s = schedule();
    const sink = dedupingSink(s);

    // Two independent pollers, each with its own cursor, both awake in slot 100
    // at DIFFERENT wall-clock instants inside the slot.
    const cursorA: TickCursor = { lastEmittedSlot: 99 };
    const cursorB: TickCursor = { lastEmittedSlot: 99 };
    await emitDueTicks({}, sink, { schedule: s, cursor: cursorA, nowMs: 100 * MINUTE + 1 });
    await emitDueTicks({}, sink, { schedule: s, cursor: cursorB, nowMs: 100 * MINUTE + 45_000 });

    expect(sink.submitted).toHaveLength(2);
    expect(sink.runs).toHaveLength(1);
    expect(sink.runs[0]!.slot).toBe(100);
  });

  it('a poller RESTART that loses its cursor re-emits the slot but does not re-run it', async () => {
    const s = schedule();
    const sink = dedupingSink(s);

    const before: TickCursor = { lastEmittedSlot: 99 };
    await emitDueTicks({}, sink, { schedule: s, cursor: before, nowMs: 100 * MINUTE + 5_000 });
    expect(sink.runs).toHaveLength(1);

    // Restart: cursor is gone, the process wakes up mid-slot-100 and treats the
    // current slot as due.
    const afterRestart: TickCursor = {};
    await emitDueTicks({}, sink, { schedule: s, cursor: afterRestart, nowMs: 100 * MINUTE + 50_000 });

    expect(sink.submitted).toHaveLength(2);
    expect(sink.submitted[1]!.slot).toBe(100);
    expect(sink.runs, 'a restart inside one slot produced a second run').toHaveLength(1);
  });

  it('successive slots are NOT deduped away — the schedule keeps running', async () => {
    // The mirror of the dedupe test: if the key were constant per schedule,
    // every test above would still pass and the flow would run exactly once,
    // ever. This is what proves the key is per-instant, not per-schedule.
    const s = schedule();
    const sink = dedupingSink(s);
    const cursor: TickCursor = { lastEmittedSlot: 99 };

    await emitDueTicks({}, sink, { schedule: s, cursor, nowMs: 100 * MINUTE });
    await emitDueTicks({}, sink, { schedule: s, cursor, nowMs: 101 * MINUTE });
    await emitDueTicks({}, sink, { schedule: s, cursor, nowMs: 102 * MINUTE });

    expect(sink.runs.map((r) => r.slot)).toEqual([100, 101, 102]);
  });
});

describe('tick source: a missed interval does not silently vanish', () => {
  it('backfills every slot a sleeping poller passed over', async () => {
    // The bound: down for four slots, back up. Emitting only the current slot
    // would lose three scheduled runs and report success.
    const s = schedule();
    const sink = dedupingSink(s);
    const cursor: TickCursor = { lastEmittedSlot: 100 };

    const result = await emitDueTicks({}, sink, { schedule: s, cursor, nowMs: 104 * MINUTE + 10 });

    expect(result.emittedSlots).toEqual([101, 102, 103, 104]);
    expect(sink.runs.map((r) => r.slot)).toEqual([101, 102, 103, 104]);
    expect(result.skippedSlots).toEqual([]);
    expect(cursor.lastEmittedSlot).toBe(104);
  });

  it('a backfilled tick carries its own lag, so a stale run can tell it is stale', async () => {
    const s = schedule();
    const sink = dedupingSink(s);
    const cursor: TickCursor = { lastEmittedSlot: 100 };

    await emitDueTicks({}, sink, { schedule: s, cursor, nowMs: 103 * MINUTE });

    expect(sink.runs.map((r) => r.lag_ms)).toEqual([2 * MINUTE, 1 * MINUTE, 0]);
  });

  it('does NOT advance past a slot whose submit failed — the next poll retries it', async () => {
    // Crash-window contract, matching `pollDirectoryOnce`'s `seen` discipline.
    const s = schedule();
    let calls = 0;
    const failing = {
      async eventSubmit(_spec: unknown, event: { type: string; payload?: unknown }) {
        calls++;
        if ((event.payload as TickPayload).slot === 102) {
          throw new Error('journal client: connection closed');
        }
        return { matched: true, deduped: false };
      },
    };
    const cursor: TickCursor = { lastEmittedSlot: 100 };

    await expect(
      emitDueTicks({}, failing, { schedule: s, cursor, nowMs: 104 * MINUTE }),
    ).rejects.toThrow(/journal client/);

    expect(calls).toBe(2);
    // 101 landed, 102 did not. The cursor must sit at 101 so 102, 103 and 104
    // are still due.
    expect(cursor.lastEmittedSlot).toBe(101);

    const recovering = dedupingSink(s);
    const result = await emitDueTicks({}, recovering, { schedule: s, cursor, nowMs: 104 * MINUTE });
    expect(result.emittedSlots).toEqual([102, 103, 104]);
  });

  it('reports slots dropped by the catch-up bound instead of dropping them quietly', async () => {
    // The bound: a week of downtime must not replay ten thousand runs, and it
    // must not pretend nothing was missed either.
    const s = schedule({ maxCatchUp: 3 });
    const sink = dedupingSink(s);
    const cursor: TickCursor = { lastEmittedSlot: 100 };

    const result = await emitDueTicks({}, sink, { schedule: s, cursor, nowMs: 110 * MINUTE });

    expect(result.emittedSlots).toEqual([108, 109, 110]);
    expect(result.skippedSlots).toEqual([101, 102, 103, 104, 105, 106, 107]);
    expect(cursor.lastEmittedSlot).toBe(110);
  });

  it('reports each skipped slot exactly once, not on every later poll', async () => {
    const s = schedule({ maxCatchUp: 2 });
    const sink = dedupingSink(s);
    const cursor: TickCursor = { lastEmittedSlot: 100 };

    const first = await emitDueTicks({}, sink, { schedule: s, cursor, nowMs: 106 * MINUTE });
    expect(first.skippedSlots).toEqual([101, 102, 103, 104]);

    const second = await emitDueTicks({}, sink, { schedule: s, cursor, nowMs: 107 * MINUTE });
    expect(second.skippedSlots).toEqual([]);
    expect(second.emittedSlots).toEqual([107]);
  });

  it('caps at DEFAULT_MAX_CATCH_UP when the schedule declares no bound', async () => {
    const s = schedule();
    const sink = dedupingSink(s);
    const cursor: TickCursor = { lastEmittedSlot: 0 };

    const result = await emitDueTicks({}, sink, { schedule: s, cursor, nowMs: 500 * MINUTE });

    expect(result.emittedSlots).toHaveLength(DEFAULT_MAX_CATCH_UP);
    expect(result.skippedSlots).toHaveLength(500 - DEFAULT_MAX_CATCH_UP);
  });
});

describe('tick source: edges', () => {
  it('the first poll on a fresh cursor emits ONE tick, not every slot since the epoch', async () => {
    const s = schedule();
    const sink = dedupingSink(s);
    const cursor: TickCursor = {};

    const result = await emitDueTicks({}, sink, { schedule: s, cursor, nowMs: 100 * MINUTE });

    expect(result.emittedSlots).toEqual([100]);
    expect(result.skippedSlots).toEqual([]);
  });

  it('emits nothing when the current slot has already been emitted', async () => {
    const s = schedule();
    const sink = dedupingSink(s);
    const cursor: TickCursor = { lastEmittedSlot: 100 };

    const result = await emitDueTicks({}, sink, { schedule: s, cursor, nowMs: 100 * MINUTE + 59_999 });

    expect(result.emittedSlots).toEqual([]);
    expect(sink.submitted).toHaveLength(0);
  });

  it('emits nothing when the clock moves backwards, and resumes at the next real slot', async () => {
    const s = schedule();
    const sink = dedupingSink(s);
    const cursor: TickCursor = { lastEmittedSlot: 100 };

    const backwards = await emitDueTicks({}, sink, { schedule: s, cursor, nowMs: 90 * MINUTE });
    expect(backwards.emittedSlots).toEqual([]);
    expect(cursor.lastEmittedSlot, 'a backwards clock rewound the cursor').toBe(100);

    const forward = await emitDueTicks({}, sink, { schedule: s, cursor, nowMs: 101 * MINUTE });
    expect(forward.emittedSlots).toEqual([101]);
  });

  it('refuses a non-positive interval rather than dividing by zero', async () => {
    await expect(
      emitDueTicks({}, dedupingSink(schedule()), {
        schedule: schedule({ intervalMs: 0 }),
        cursor: {},
        nowMs: 1,
      }),
    ).rejects.toThrow(/intervalMs must be a positive integer/);
  });

  it('refuses an empty schedule id, which would collide with another schedule', async () => {
    await expect(
      emitDueTicks({}, dedupingSink(schedule()), {
        schedule: schedule({ scheduleId: '' }),
        cursor: {},
        nowMs: 1,
      }),
    ).rejects.toThrow(/scheduleId must be a non-empty string/);
  });
});

describe('tick source and the worked example agree', () => {
  const flow = compileYaml(readFileSync(join(TESTDATA, 'tick-heartbeat.flow.yaml'), 'utf8'));
  const trigger = flow.triggers![0]!;

  it('the spec subscribes to the event type the source emits', () => {
    expect(trigger.eventType).toBe(TICK_EVENT_TYPE);
  });

  it('the spec dedupes on the scheduled instant, not on the emit time', () => {
    expect(trigger.dedupeKeyTemplate).toBe(TICK_DEDUPE_KEY_TEMPLATE);
    expect(trigger.dedupeKeyTemplate).not.toContain('emitted_at_ms');
  });

  it('the spec declares a silence budget, so the schedule cannot die quietly', () => {
    // Without this the engine default applies and the flow's own author has
    // made no statement about how long silence is acceptable.
    expect(trigger.staleAfterMs).toBeGreaterThan(0);
    expect(toKernelSpec(flow).triggers![0]!.stale_after_ms).toBe(trigger.staleAfterMs);
  });

  it('the spec narrows to one schedule id, so sibling schedules cannot wake it', () => {
    expect(trigger.pattern).toEqual({ schedule_id: 'heartbeat-1m' });
  });
});

describe('P2-1: a skip is never lost, even when the same poll fails', () => {
  // The module promises "the skip cannot be silent". It broke that promise in
  // exactly one path: the cursor was advanced past the skipped slots BEFORE
  // the emit loop, so a submit failure threw away the only report of them and
  // left the cursor past the evidence. Silently zero — the failure class this
  // whole PR exists to address.

  it('carries the skipped slots on the error when a later submit fails', async () => {
    const s = schedule({ maxCatchUp: 3 });
    const failing = {
      async eventSubmit(_spec: unknown, event: { payload?: unknown }) {
        if ((event.payload as TickPayload).slot === 109) throw new Error('journal client: closed');
        return { matched: true, deduped: false };
      },
    };
    const cursor: TickCursor = { lastEmittedSlot: 100 };

    // due = 101..110; skipped = 101..107; toEmit = 108,109,110. 108 lands, 109 dies.
    const error = await emitDueTicks({}, failing, { schedule: s, cursor, nowMs: 110 * MINUTE })
      .then(() => undefined, (e: unknown) => e);

    expect(error, 'the failing submit did not throw').toBeInstanceOf(TickEmitError);
    const thrown = error as TickEmitError;
    expect(thrown.skippedSlots, 'seven skipped slots vanished with no report anywhere')
      .toEqual([101, 102, 103, 104, 105, 106, 107]);
    expect(thrown.emittedSlots).toEqual([108]);
    expect(thrown.cause).toBeInstanceOf(Error);
  });

  it('leaves the skipped slots re-derivable when the FIRST submit fails', async () => {
    // Nothing reached the kernel, so the cursor must not have moved at all —
    // the next poll has to be able to re-derive the whole due range.
    const s = schedule({ maxCatchUp: 3 });
    const failing = { async eventSubmit() { throw new Error('journal client: closed'); } };
    const cursor: TickCursor = { lastEmittedSlot: 100 };

    await expect(emitDueTicks({}, failing, { schedule: s, cursor, nowMs: 110 * MINUTE }))
      .rejects.toThrow(/journal client/);
    expect(cursor.lastEmittedSlot, 'cursor advanced past slots that never reached the kernel')
      .toBe(100);

    // Recovery poll re-derives the same accounting.
    const recovering = dedupingSink(s);
    const retry = await emitDueTicks({}, recovering, { schedule: s, cursor, nowMs: 110 * MINUTE });
    expect(retry.skippedSlots).toEqual([101, 102, 103, 104, 105, 106, 107]);
    expect(retry.emittedSlots).toEqual([108, 109, 110]);
  });

  it('still reports a skip exactly once on the success path', async () => {
    // Guard against over-correcting: the fix must not re-report skips forever.
    const s = schedule({ maxCatchUp: 2 });
    const sink = dedupingSink(s);
    const cursor: TickCursor = { lastEmittedSlot: 100 };

    expect((await emitDueTicks({}, sink, { schedule: s, cursor, nowMs: 106 * MINUTE })).skippedSlots)
      .toEqual([101, 102, 103, 104]);
    expect((await emitDueTicks({}, sink, { schedule: s, cursor, nowMs: 107 * MINUTE })).skippedSlots)
      .toEqual([]);
  });
});

describe('P2-2: an uncomputable grid refuses instead of going quiet', () => {
  // A NaN epochMs or nowMs made slotFor() return NaN, so firstDue > currentSlot
  // was false-y in the wrong direction and the poll returned an empty result:
  // no submit, no skip, no throw. A schedule permanently and silently zero,
  // which is precisely Native's silent-death problem.
  it.each([
    ['epochMs', Number.NaN],
    ['epochMs', Number.POSITIVE_INFINITY],
    ['epochMs', -1],
    ['epochMs', 1.5],
    ['nowMs', Number.NaN],
    ['nowMs', Number.POSITIVE_INFINITY],
    ['nowMs', -1],
    ['nowMs', 1.5],
  ])('refuses %s = %p', async (field, value) => {
    const s = schedule(field === 'epochMs' ? { epochMs: value } : {});
    const nowMs = field === 'nowMs' ? value : 100 * MINUTE;
    await expect(
      emitDueTicks({}, dedupingSink(schedule()), { schedule: s, cursor: {}, nowMs }),
    ).rejects.toThrow(new RegExp(`${field} must be a non-negative integer`));
  });

  it('still accepts the zero epoch and a zero now', async () => {
    const s = schedule({ epochMs: 0 });
    const sink = dedupingSink(s);
    const result = await emitDueTicks({}, sink, { schedule: s, cursor: {}, nowMs: 0 });
    expect(result.emittedSlots).toEqual([0]);
  });

  it('refuses a NaN maxCatchUp too', async () => {
    await expect(
      emitDueTicks({}, dedupingSink(schedule()), {
        schedule: schedule({ maxCatchUp: Number.NaN }), cursor: {}, nowMs: 100 * MINUTE,
      }),
    ).rejects.toThrow(/maxCatchUp must be a positive integer/);
  });
});
