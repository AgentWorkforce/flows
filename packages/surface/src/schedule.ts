/**
 * Schedule triggers. Hand-written, unlike the provider namespaces under
 * `triggers/`, because a schedule is not a provider event: there is no inbox
 * and no upstream mapping to generate from. A schedule is an event source —
 * locally the `flows tick` runner, on Cloud a relaycron cron — that submits
 * `flows.tick` events, and this namespace declares which ticks a flow wants.
 *
 * Constructing a source opens nothing. The SDK lowers it to the same
 * `flows.tick` subscription `testdata/tick-heartbeat.flow.yaml` writes by
 * hand (`scheduleTriggerSpec`), and `flows schedule` sends the cron to Cloud.
 */

export interface ScheduleTriggerSource {
  readonly kind: "schedule";
  /** Fixed: every schedule is delivered as a `flows.tick` event. */
  readonly name: "flows.tick";
  /** A 5-field cron expression, when declared with `schedule.cron`. */
  readonly cron?: string;
  /** IANA zone for `cron`; defaults to UTC. */
  readonly tz?: string;
  /** Fixed interval in milliseconds, when declared with `schedule.every` or derivable from `cron`. */
  readonly intervalMs?: number;
}

export interface ScheduleCronOptions {
  readonly tz?: string;
}

const EVERY = /^(\d+)(s|m|h|d)$/u;
const UNIT_MS = { s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 } as const;

/** `every("5m")` — a fixed interval. Units: s, m, h, d. Minimum one second. */
export function everyToMs(value: string): number {
  const match = typeof value === "string" ? EVERY.exec(value.trim()) : null;
  if (!match) throw new TypeError(`schedule.every expects <n><s|m|h|d>, got ${JSON.stringify(value)}`);
  const ms = Number(match[1]) * UNIT_MS[match[2] as keyof typeof UNIT_MS];
  if (!Number.isSafeInteger(ms) || ms < 1_000) throw new TypeError("schedule.every must be at least 1s");
  return ms;
}

export interface CronFields {
  readonly minute: string;
  readonly hour: string;
  readonly dayOfMonth: string;
  readonly month: string;
  readonly dayOfWeek: string;
}

const FIELD_RANGES = [[0, 59], [0, 23], [1, 31], [1, 12], [0, 7]] as const;
const NAMES: Record<number, readonly string[]> = {
  3: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"],
  4: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"],
};

/**
 * Standard five-field cron. Accepts `*`, values, ranges, lists and `/step`,
 * plus month and weekday names; refuses anything outside each field's range.
 * Validation, not evaluation — the schedule's clock is the runner's.
 */
export function parseCron(expression: string): CronFields {
  const fields = typeof expression === "string" ? expression.trim().split(/\s+/u) : [];
  if (fields.length !== 5) {
    throw new TypeError(`cron expression must have five fields (minute hour day-of-month month day-of-week), got ${JSON.stringify(expression)}`);
  }
  fields.forEach((field, index) => {
    const [low, high] = FIELD_RANGES[index]!;
    for (const part of field.split(",")) {
      const [range, step] = part.split("/");
      if (step !== undefined && (!/^\d+$/u.test(step) || Number(step) < 1)) {
        throw new TypeError(`cron field ${index + 1}: invalid step in ${JSON.stringify(part)}`);
      }
      if (range === "*") continue;
      const bounds = range!.split("-");
      if (bounds.length > 2) throw new TypeError(`cron field ${index + 1}: invalid range ${JSON.stringify(part)}`);
      for (const bound of bounds) {
        // Month names are 1-based (jan = 1); weekday names are 0-based (sun = 0).
        const named = NAMES[index]?.indexOf(bound.toLowerCase());
        const value = /^\d+$/u.test(bound) ? Number(bound)
          : named === undefined || named === -1 ? undefined : named + (index === 3 ? 1 : 0);
        if (value === undefined || value < low || value > high) {
          throw new TypeError(`cron field ${index + 1}: ${JSON.stringify(bound)} is outside ${low}-${high}`);
        }
      }
    }
  });
  return Object.freeze({
    minute: fields[0]!, hour: fields[1]!, dayOfMonth: fields[2]!, month: fields[3]!, dayOfWeek: fields[4]!,
  });
}

// The fixed interval a cron expression amounts to, when it has one: every N
// minutes (`*/N * * * *`), every N hours at a fixed minute, or every hour.
// Anything else (a daily instant, specific weekdays, lists, ranges) is not a
// fixed interval and yields undefined — the local tick runner cannot drive
// it; only a cron-aware runner (Cloud's relaycron) can.
export function cronFixedIntervalMs(fields: CronFields): number | undefined {
  const { minute, hour, dayOfMonth, month, dayOfWeek } = fields;
  if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") return undefined;
  const step = (field: string): number | undefined => {
    if (field === "*") return 1;
    const match = /^\*\/(\d+)$/u.exec(field);
    return match ? Number(match[1]) : undefined;
  };
  const minuteStep = step(minute);
  if (minuteStep !== undefined && hour === "*") return minuteStep * UNIT_MS.m;
  const hourStep = step(hour);
  if (/^\d+$/u.test(minute) && hourStep !== undefined) return hourStep * UNIT_MS.h;
  return undefined;
}

function assertTimeZone(tz: string): string {
  if (typeof tz !== "string" || tz.trim().length === 0) throw new TypeError("schedule tz must be an IANA zone name");
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new TypeError(`schedule tz ${JSON.stringify(tz)} is not a known IANA zone`);
  }
  return tz;
}

export const schedule = Object.freeze({
  /** A five-field cron, evaluated in `tz` (default UTC). */
  cron(expression: string, options: ScheduleCronOptions = {}): ScheduleTriggerSource {
    const fields = parseCron(expression);
    const intervalMs = cronFixedIntervalMs(fields);
    return Object.freeze({
      kind: "schedule", name: "flows.tick",
      cron: expression.trim(),
      ...(options.tz === undefined ? {} : { tz: assertTimeZone(options.tz) }),
      ...(intervalMs === undefined ? {} : { intervalMs }),
    });
  },
  /** A fixed interval: `every("5m")`, `every("2h")`. Units s, m, h, d. */
  every(interval: string): ScheduleTriggerSource {
    return Object.freeze({ kind: "schedule", name: "flows.tick", intervalMs: everyToMs(interval) });
  },
});

/**
 * The `schedule_id` a flow's schedule subscribes to. Deterministic from the
 * flow name and the declaration, so the local runner, `flows check` and the
 * journal all name the same slot stream without a registry.
 */
export function scheduleIdFor(flowName: string, source: ScheduleTriggerSource): string {
  const spec = source.cron !== undefined
    ? `cron:${source.cron}${source.tz === undefined ? "" : `@${source.tz}`}`
    : `every:${source.intervalMs}ms`;
  const slug = `${flowName}:${spec}`.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "");
  return slug.slice(0, 120);
}
