/**
 * Scheduled ticks -> relayflow events.
 *
 * A relayflow could not be scheduled. `grep -rniE "cron|schedule|interval"` over
 * `spec.ts` and `compile.ts` returned nothing, and every shipped trigger is fed
 * by a poller reacting to something external (`hn-poller.ts`,
 * `dir-watcher-poller.ts`). "Run this flow every ten minutes" had no expression.
 *
 * RFC-0001 already decided the shape, so this is deliberately NOT a `cron:`
 * field on the kernel spec:
 *
 *   - gate 2 "proves: triggers are entry conditions, not schedulers";
 *   - the first dogfood run (2026-08-27) is on record for "a cron trigger
 *     reported `succeeded` into a void with no worker enrolled" — a scheduler
 *     inside the kernel is exactly what produced that;
 *   - the trigger plane is liveness-checked "because a flow that is never
 *     triggered is silently zero — Native's silent-death problem".
 *
 * So a schedule is an EVENT SOURCE, sitting beside the directory watcher and
 * the HN poller, speaking the same `event.submit` path, and subject to the same
 * liveness sweep as any other subscription. The kernel learns about time the
 * way it learns about everything else: as an event.
 *
 * ## The slot grid
 *
 * Time is divided into fixed slots anchored at `epochMs`:
 *
 *     slot(t)          = floor((t - epochMs) / intervalMs)
 *     scheduledForMs(n) = epochMs + n * intervalMs
 *
 * A slot is an interval of the grid, not a moment the poller happened to wake
 * up. That distinction is the whole design. `scheduledForMs` is a pure function
 * of the grid, so the same slot has the same identity no matter when — or how
 * many times — a poller notices it. Wall-clock-at-emit would give two different
 * identities to one scheduled instant and produce two runs.
 *
 * ## Two failure modes, two different mechanisms
 *
 * They are separate on purpose, and neither one covers for the other:
 *
 *   - **Duplicates** are prevented by the dedupe key, which is derived from
 *     `(schedule_id, scheduled_for_ms)` through the flow's `dedupeKeyTemplate`.
 *     The kernel's `(flow_key, subscription_id, dedupe_key)` claim then makes
 *     the second delivery of a slot a no-op. This holds for a double-fire, a
 *     re-delivery, two pollers racing, and a poller that restarts with a lost
 *     cursor and re-emits a slot it already emitted.
 *
 *   - **Skips** are prevented by the cursor. `emitDueTicks` emits every slot
 *     between the last one it emitted and now, not just the current one, so a
 *     poller that was asleep across three slots backfills three ticks rather
 *     than silently dropping two. The cursor advances only after a successful
 *     submit, so a journal failure mid-backfill leaves the rest for the next
 *     poll — the same discipline `dir-watcher-poller` applies to its `seen` set.
 *
 * The cursor is caller-owned (a plain JSON-serializable object) precisely so a
 * caller that wants restart-safe backfill can persist it. A caller that does
 * not persist it loses backfill across a restart but CANNOT double-run a slot,
 * because that bound belongs to the dedupe key rather than to the cursor.
 */

/** Anything that can submit an event through the journal protocol. */
export interface EventSink {
  eventSubmit(spec: unknown, event: { type: string; payload?: unknown; key?: string }): Promise<unknown>;
}

/** The event type every tick carries. */
export const TICK_EVENT_TYPE = 'flows.tick';

/**
 * The dedupe key template a tick-triggered flow must declare. Exported so a
 * spec and this source cannot drift: `testdata/tick-heartbeat.flow.yaml` uses
 * this exact string and `tests/tick-source.test.ts` asserts they match.
 *
 * `scheduled_for_ms` — not `emitted_at_ms` — is what makes the key idempotent.
 */
export const TICK_DEDUPE_KEY_TEMPLATE =
  '{{event.type}}:{{payload.schedule_id}}:{{payload.scheduled_for_ms}}';

/** Default bound on how many missed slots one poll will backfill. */
export const DEFAULT_MAX_CATCH_UP = 60;

/** A declared schedule. Pure data — no timers, no I/O, no ambient clock. */
export interface TickSchedule {
  /**
   * Stable identity of this schedule. It is half the dedupe key, so changing
   * it re-runs every slot; two schedules on one flow must differ here.
   */
  scheduleId: string;
  /** Slot width in milliseconds. Must be a positive integer. */
  intervalMs: number;
  /**
   * Grid anchor. Slots are measured from here, so this is what decides whether
   * an hourly schedule fires on the hour or at seven minutes past. Defaults to
   * 0 (the Unix epoch), which puts an hourly schedule on the hour in UTC.
   */
  epochMs?: number;
  /**
   * Upper bound on slots backfilled in a single poll. A poller down for a week
   * on a one-minute schedule has ten thousand outstanding slots, and replaying
   * all of them would be a stampede, not a recovery. Slots beyond the bound are
   * REPORTED in the result rather than dropped quietly (see `TickEmitResult`).
   */
  maxCatchUp?: number;
}

/**
 * Caller-owned cursor. Plain JSON so a caller can persist it across restarts.
 * `emitDueTicks` mutates it in place, exactly as `pollDirectoryOnce` mutates
 * its `seen` set.
 */
export interface TickCursor {
  /** Highest slot successfully submitted, or undefined before the first poll. */
  lastEmittedSlot?: number;
}

/** The payload of one `flows.tick` event. */
export interface TickPayload {
  schedule_id: string;
  /** Slot index on the grid. Monotonic, and stable across restarts. */
  slot: number;
  /** The scheduled instant this tick stands for. The dedupe identity. */
  scheduled_for_ms: number;
  interval_ms: number;
  /**
   * Wall clock when the tick was submitted. Observability only — it is
   * deliberately NOT part of the dedupe key, because it differs between a
   * first delivery and a re-delivery of the same slot.
   */
  emitted_at_ms: number;
  /**
   * How far behind the grid this emission was, in milliseconds
   * (`emitted_at_ms - scheduled_for_ms`). A catch-up tick carries a large
   * value; a punctual one carries roughly zero. Lets a flow tell "I am running
   * for a slot from an hour ago" from "I am running for now".
   */
  lag_ms: number;
}

/** What one poll did, including what it deliberately did not do. */
export interface TickEmitResult {
  /** Slots submitted this poll, oldest first. */
  emittedSlots: number[];
  /** The submit outcomes, index-aligned with `emittedSlots`. */
  outcomes: unknown[];
  /**
   * Slots that were due but fell outside `maxCatchUp`, oldest first. Non-empty
   * means real scheduled work was passed over: the caller MUST surface it. It
   * is returned rather than thrown so a poller that was down for a week still
   * recovers to the current slot instead of wedging, and it is returned rather
   * than ignored so the skip cannot be silent.
   */
  skippedSlots: number[];
}

/** Slot index containing `nowMs` on this schedule's grid. */
export function slotFor(schedule: TickSchedule, nowMs: number): number {
  return Math.floor((nowMs - (schedule.epochMs ?? 0)) / schedule.intervalMs);
}

/** The scheduled instant of a slot. Pure function of the grid, never of `now`. */
export function scheduledForMs(schedule: TickSchedule, slot: number): number {
  return (schedule.epochMs ?? 0) + slot * schedule.intervalMs;
}

/**
 * The dedupe key the kernel will derive for a slot, computed here so a test can
 * assert the identity directly without a live kernel. Kept in lockstep with
 * `TICK_DEDUPE_KEY_TEMPLATE`; `tests/tick-source.test.ts` pins the agreement.
 */
export function tickDedupeKey(schedule: TickSchedule, slot: number): string {
  return `${TICK_EVENT_TYPE}:${schedule.scheduleId}:${scheduledForMs(schedule, slot)}`;
}

/**
 * Error thrown when a submit inside `emitDueTicks` fails, carrying the poll's
 * accounting so far.
 *
 * A plain rethrow discarded `skippedSlots` — the ONLY record that real
 * scheduled work had been passed over, since a skipped slot never reaches the
 * kernel and nothing downstream would ever see it. That made the skip silent
 * in exactly the failure path where an operator most needs it, contradicting
 * this module's own guarantee and reproducing the silent-death class the whole
 * primitive exists to prevent.
 */
export class TickEmitError extends Error {
  readonly emittedSlots: number[];
  readonly outcomes: unknown[];
  readonly skippedSlots: number[];
  constructor(result: TickEmitResult, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `tick emit failed after ${result.emittedSlots.length} slot(s)`
      + `${result.skippedSlots.length > 0 ? `, with ${result.skippedSlots.length} slot(s) skipped by the catch-up bound` : ''}`
      + `: ${detail}`,
      { cause },
    );
    this.name = 'TickEmitError';
    this.emittedSlots = result.emittedSlots;
    this.outcomes = result.outcomes;
    this.skippedSlots = result.skippedSlots;
  }
}

function requirePositiveInteger(value: number, field: string): void {
  // `Number.isInteger` is false for NaN and for both infinities, so this one
  // check covers all three.
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`tick schedule: ${field} must be a positive integer, got ${String(value)}`);
  }
}

/**
 * `epochMs` and `nowMs` reach arithmetic that decides whether ANY slot is due.
 * They were unvalidated while `intervalMs` was not, and the asymmetry was the
 * bug: a NaN made `slotFor` return NaN, every comparison against it false, and
 * the poll returned an empty result — no submit, no skip, no throw. A schedule
 * permanently and silently zero. An infinity was worse than quiet but no
 * better as a diagnosis: the backfill loop died with `Invalid array length`.
 *
 * A grid that cannot be computed must refuse at the call, loudly and by name.
 */
function requireNonNegativeInteger(value: number, field: string): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`tick schedule: ${field} must be a non-negative integer, got ${String(value)}`);
  }
}

/**
 * Submit a `flows.tick` event for every slot that has come due since the cursor
 * last advanced, and move the cursor.
 *
 * The FIRST poll on a fresh cursor emits only the current slot. Backfilling
 * from the grid anchor instead would replay every slot since the Unix epoch on
 * the first tick of a new schedule.
 *
 * Journal errors from `eventSubmit` propagate, with the cursor left pointing at
 * the last slot that actually reached the kernel.
 */
export async function emitDueTicks(
  spec: unknown,
  sink: EventSink,
  options: { schedule: TickSchedule; cursor: TickCursor; nowMs: number },
): Promise<TickEmitResult> {
  const { schedule, cursor, nowMs } = options;
  requirePositiveInteger(schedule.intervalMs, 'intervalMs');
  const maxCatchUp = schedule.maxCatchUp ?? DEFAULT_MAX_CATCH_UP;
  requirePositiveInteger(maxCatchUp, 'maxCatchUp');
  requireNonNegativeInteger(schedule.epochMs ?? 0, 'epochMs');
  requireNonNegativeInteger(nowMs, 'nowMs');
  if (schedule.scheduleId === '') {
    throw new Error('tick schedule: scheduleId must be a non-empty string');
  }

  const currentSlot = slotFor(schedule, nowMs);
  const firstDue = cursor.lastEmittedSlot === undefined
    ? currentSlot
    : cursor.lastEmittedSlot + 1;

  // Clock went backwards, or the cursor is ahead of the grid. Emitting nothing
  // is correct: those slots are already claimed, and re-emitting them would be
  // deduped anyway.
  if (firstDue > currentSlot) {
    return { emittedSlots: [], outcomes: [], skippedSlots: [] };
  }

  const due: number[] = [];
  for (let slot = firstDue; slot <= currentSlot; slot++) due.push(slot);

  // Over the bound: keep the NEWEST slots. The current slot is the one whose
  // work is still relevant; the oldest are the most stale. Report the rest.
  const skippedSlots = due.length > maxCatchUp ? due.slice(0, due.length - maxCatchUp) : [];
  const toEmit = due.length > maxCatchUp ? due.slice(due.length - maxCatchUp) : due;

  // The cursor is NOT advanced past `skippedSlots` here. It used to be, and
  // that lost the skip outright: if a submit then threw, the returned result
  // — the only place `skippedSlots` lived — was discarded, while the cursor
  // had already moved past the evidence, so the next poll could not re-derive
  // it either. Seven skipped slots could vanish with no report anywhere.
  //
  // Instead the skip is accounted for by whichever of these happens:
  //   - a submit succeeds, advancing the cursor past the skipped slots as a
  //     side effect, and the result carries `skippedSlots` (the happy path,
  //     still reported exactly once);
  //   - a submit throws, and `TickEmitError` carries `skippedSlots` to the
  //     caller;
  //   - nothing was submitted at all, so the cursor never moved and the next
  //     poll re-derives the identical due range.
  // No path drops it.
  const result: TickEmitResult = { emittedSlots: [], outcomes: [], skippedSlots };
  for (const slot of toEmit) {
    const scheduledFor = scheduledForMs(schedule, slot);
    const payload: TickPayload = {
      schedule_id: schedule.scheduleId,
      slot,
      scheduled_for_ms: scheduledFor,
      interval_ms: schedule.intervalMs,
      emitted_at_ms: nowMs,
      lag_ms: nowMs - scheduledFor,
    };
    let outcome: unknown;
    try {
      outcome = await sink.eventSubmit(spec, { type: TICK_EVENT_TYPE, payload });
    } catch (cause) {
      // Fail closed, but never quietly: the partial accounting travels with
      // the failure instead of dying with the discarded return value.
      throw new TickEmitError(result, cause);
    }
    result.outcomes.push(outcome);
    // Advance ONLY after the submit succeeded. A journal failure must leave
    // this slot due so the next poll retries it — the same rule
    // `pollDirectoryOnce` applies to its `seen` set, and the reason a crash
    // mid-backfill cannot swallow a slot.
    cursor.lastEmittedSlot = slot;
    result.emittedSlots.push(slot);
  }

  return result;
}
