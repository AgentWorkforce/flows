import {
  TICK_EVENT_TYPE, TICK_DEDUPE_KEY_TEMPLATE,
} from './tick-source.js';
import { scheduleIdFor, type ScheduleTriggerSource } from '@relayflows/surface';
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
  /** The `flows tick start --interval-ms` value, when the schedule is a fixed interval. */
  readonly intervalMs?: number;
  readonly cron?: string;
  readonly tz?: string;
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
  if (source.intervalMs === undefined) {
    return {
      ...base,
      localUnsupported: `cron "${source.cron}" is not a fixed interval; the local tick runner drives only `
        + 'every(...) and */N crons. Run it on Cloud with `flows schedule`, or declare schedule.every(...) for local runs.',
    };
  }
  return { ...base, intervalMs: source.intervalMs };
}

/**
 * Lower a `schedule.*` declaration to the `flows.tick` subscription the tick
 * source drives: one event type, a pattern pinned to this flow's schedule id,
 * the shared dedupe key so a re-delivered slot spawns one run, and a silence
 * budget of three slots so a dead source is journaled rather than silent.
 * A cron with no fixed interval gets no `staleAfterMs`: its silence budget
 * belongs to the cron-aware runner that fires it.
 */
export function scheduleTriggerSpec(id: string, flowName: string, source: ScheduleTriggerSource): TriggerSpec {
  const lowering = scheduleLowering(flowName, source);
  return {
    id,
    executor: SCHEDULE_EXECUTOR,
    eventType: TICK_EVENT_TYPE,
    pattern: { schedule_id: lowering.scheduleId },
    dedupeKeyTemplate: TICK_DEDUPE_KEY_TEMPLATE,
    ...(lowering.intervalMs === undefined ? {} : { staleAfterMs: lowering.intervalMs * SCHEDULE_STALE_SLOTS }),
  };
}
