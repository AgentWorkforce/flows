import {
  TICK_EVENT_TYPE, TICK_DEDUPE_KEY_TEMPLATE,
} from './tick-source.js';
import { cronMaxGapMs, parseCron, scheduleIdFor, type ScheduleTriggerSource } from '@relayflows/surface';
import type { TriggerSpec } from './spec.js';

/**
 * The executor name a schedule subscription is registered under. It is the
 * name `flows tick start` submits through, and `testdata/tick-heartbeat.flow.yaml`
 * binds by hand; unlike a provider inbox it needs no `flows.json` entry, because
 * the tick source ships with the CLI itself.
 */
export const SCHEDULE_EXECUTOR = 'flows.tick';

/** Three missed slots before the kernel's liveness sweep journals `subscription.stale`. */
export const SCHEDULE_STALE_SLOTS = 3;

export interface ScheduleLowering {
  readonly scheduleId: string;
  /** The `flows tick start --interval-ms` value, when the schedule is exactly a tick grid. */
  readonly intervalMs?: number;
  /** The `flows tick start --epoch-ms` value: the grid's phase past the Unix epoch. Present with `intervalMs`. */
  readonly epochMs?: number;
  readonly cron?: string;
  readonly tz?: string;
  /** The silence budget the subscription declares, in milliseconds. */
  readonly staleAfterMs?: number;
  /** Why the local tick runner cannot drive this schedule, when it cannot. */
  readonly localUnsupported?: string;
}

export function scheduleLowering(flowName: string, source: ScheduleTriggerSource): ScheduleLowering {
  const scheduleId = scheduleIdFor(flowName, source);
  const base = {
    scheduleId,
    ...(source.cron === undefined ? {} : { cron: source.cron }),
    ...(source.tz === undefined ? {} : { tz: source.tz }),
  };
  if (source.intervalMs === undefined || source.epochMs === undefined) {
    // Not a grid. The kernel's default silence budget is five minutes, which
    // a daily cron would trip every day at 09:05 — so the budget is declared
    // from the cron's own longest quiet period instead of left to default.
    const gap = source.cron === undefined ? undefined : cronMaxGapMs(parseCron(source.cron));
    return {
      ...base,
      ...(gap === undefined ? {} : { staleAfterMs: gap * SCHEDULE_STALE_SLOTS }),
      localUnsupported: `cron "${source.cron}"${source.tz === undefined ? '' : ` in ${source.tz}`} is not a UTC tick grid `
        + '(a fixed period dividing the hour or day, one fixed phase); the local tick runner cannot reproduce it. '
        + 'Run it on Cloud with `flows schedule`, or declare schedule.every(...) for local runs.',
    };
  }
  return { ...base, intervalMs: source.intervalMs, epochMs: source.epochMs, staleAfterMs: source.intervalMs * SCHEDULE_STALE_SLOTS };
}

/**
 * Lower a `schedule.*` declaration to the `flows.tick` subscription the tick
 * source drives: one event type, a pattern pinned to this flow's schedule id,
 * the shared dedupe key so a re-delivered slot spawns one run, and a silence
 * budget of three slots — three intervals for a grid, three times the cron's
 * longest quiet period otherwise — so a dead source is journaled rather than
 * silent, and a weekly cron is not declared stale on Monday at 09:05.
 */
export function scheduleTriggerSpec(id: string, flowName: string, source: ScheduleTriggerSource): TriggerSpec {
  const lowering = scheduleLowering(flowName, source);
  return {
    id,
    executor: SCHEDULE_EXECUTOR,
    eventType: TICK_EVENT_TYPE,
    pattern: { schedule_id: lowering.scheduleId },
    dedupeKeyTemplate: TICK_DEDUPE_KEY_TEMPLATE,
    ...(lowering.staleAfterMs === undefined ? {} : { staleAfterMs: lowering.staleAfterMs }),
  };
}
