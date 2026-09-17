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
  /** Fixed interval in milliseconds, when declared with `schedule.every` or when `cron` is exactly a tick grid. */
  readonly intervalMs?: number;
  /** Phase of that grid: the first fire is `epochMs` past the Unix epoch; present exactly when `intervalMs` is. */
  readonly epochMs?: number;
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
      const pieces = part.split("/");
      if (pieces.length > 2 || part.length === 0) throw new TypeError(`cron field ${index + 1}: invalid ${JSON.stringify(part)}`);
      const [range, step] = pieces;
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

/** A tick grid that reproduces a cron exactly: fire every `intervalMs`, phase-aligned at `epochMs` past the Unix epoch. */
export interface CronGrid {
  readonly intervalMs: number;
  readonly epochMs: number;
}

// The tick grid a cron expression amounts to, when one reproduces it exactly.
// The tick source fires at epochMs + k*intervalMs, so a cron is representable
// only when its period divides the next field's cycle (every N minutes with
// 60 % N == 0, every N hours with 24 % N == 0) and its phase is a single
// fixed value in the finer fields. `*/7 * * * *` is not (cron restarts the
// minute count each hour, a grid does not); `15 * * * *` is, with a 15-minute
// phase. Anything with day, month or weekday constraints, lists or ranges is
// not a grid — only a cron-aware runner (Cloud's relaycron) can drive it.
// Time zones: a grid is anchored in UTC, so only UTC schedules qualify; an
// offset zone would shift the phase and a DST zone would move it twice a year.
export function cronGrid(fields: CronFields, tz?: string): CronGrid | undefined {
  const { minute, hour, dayOfMonth, month, dayOfWeek } = fields;
  if (dayOfMonth !== "*" || month !== "*" || dayOfWeek !== "*") return undefined;
  if (tz !== undefined && tz !== "UTC" && tz !== "Etc/UTC") return undefined;
  const every = (field: string, cycle: number): number | undefined => {
    if (field === "*") return 1;
    const match = /^\*\/(\d+)$/u.exec(field);
    if (!match) return undefined;
    const step = Number(match[1]);
    return step >= 1 && cycle % step === 0 ? step : undefined;
  };
  const fixed = (field: string): number | undefined => (/^\d+$/u.test(field) ? Number(field) : undefined);
  const minuteStep = every(minute, 60);
  if (minuteStep !== undefined && hour === "*") return { intervalMs: minuteStep * UNIT_MS.m, epochMs: 0 };
  const minutePhase = fixed(minute);
  const hourStep = every(hour, 24);
  if (minutePhase !== undefined && hourStep !== undefined) {
    return { intervalMs: hourStep * UNIT_MS.h, epochMs: minutePhase * UNIT_MS.m };
  }
  const hourPhase = fixed(hour);
  if (minutePhase !== undefined && hourPhase !== undefined) {
    return { intervalMs: UNIT_MS.d, epochMs: hourPhase * UNIT_MS.h + minutePhase * UNIT_MS.m };
  }
  return undefined;
}

/** The fixed interval of a cron, when `cronGrid` finds one. Kept for callers that only need the period. */
export function cronFixedIntervalMs(fields: CronFields, tz?: string): number | undefined {
  return cronGrid(fields, tz)?.intervalMs;
}

function cronFieldMatches(field: string, value: number, index: number): boolean {
  const [low, high] = FIELD_RANGES[index]!;
  const named = (bound: string): number => {
    if (/^\d+$/u.test(bound)) return Number(bound);
    return NAMES[index]!.indexOf(bound.toLowerCase()) + (index === 3 ? 1 : 0);
  };
  return field.split(",").some((part) => {
    const [range, step] = part.split("/");
    const stride = step === undefined ? 1 : Number(step);
    let from: number;
    let to: number;
    if (range === "*") { from = low; to = high; }
    else {
      const bounds = range!.split("-").map(named);
      from = bounds[0]!;
      to = bounds.length === 2 ? bounds[1]! : step === undefined ? bounds[0]! : high;
    }
    // Weekday 7 is Sunday, as 0 is.
    const candidate = index === 4 && value === 0 && (from === 7 || to === 7) ? 7 : value;
    return candidate >= from && candidate <= to && (candidate - from) % stride === 0;
  });
}

/**
 * The longest gap between consecutive fires over two calendar years (one of
 * them leap), in milliseconds — a cron's natural quiet period. Evaluated on
 * the UTC calendar minute by minute; a zone offset does not change gap
 * lengths, and a DST shift changes one gap by at most an hour, which the
 * callers' multiple absorbs. An expression that fires at most once in the
 * span reports the whole span. Returns undefined when it never fires.
 */
export function cronMaxGapMs(fields: CronFields): number | undefined {
  const start = Date.UTC(2024, 0, 1);
  const end = Date.UTC(2026, 0, 1);
  let previous: number | undefined;
  let first: number | undefined;
  let maxGap = 0;
  for (let t = start; t < end; t += UNIT_MS.m) {
    const d = new Date(t);
    const dom = fields.dayOfMonth === "*";
    const dow = fields.dayOfWeek === "*";
    const dayMatches = dom && dow
      ? true
      // POSIX: when both day fields are restricted, either matching fires.
      : dom !== dow
        ? (dom ? cronFieldMatches(fields.dayOfWeek, d.getUTCDay(), 4) : cronFieldMatches(fields.dayOfMonth, d.getUTCDate(), 2))
        : cronFieldMatches(fields.dayOfMonth, d.getUTCDate(), 2) || cronFieldMatches(fields.dayOfWeek, d.getUTCDay(), 4);
    if (!dayMatches || !cronFieldMatches(fields.month, d.getUTCMonth() + 1, 3)
      || !cronFieldMatches(fields.hour, d.getUTCHours(), 1) || !cronFieldMatches(fields.minute, d.getUTCMinutes(), 0)) continue;
    if (previous !== undefined) maxGap = Math.max(maxGap, t - previous);
    else first = t;
    previous = t;
  }
  if (first === undefined || previous === undefined) return undefined;
  return maxGap > 0 ? maxGap : end - start;
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
    const tz = options.tz === undefined ? undefined : assertTimeZone(options.tz);
    const grid = cronGrid(fields, tz);
    return Object.freeze({
      kind: "schedule", name: "flows.tick",
      cron: expression.trim().split(/\s+/u).join(" "),
      ...(tz === undefined ? {} : { tz }),
      ...(grid === undefined ? {} : { intervalMs: grid.intervalMs, epochMs: grid.epochMs }),
    });
  },
  /** A fixed interval: `every("5m")`, `every("2h")`. Units s, m, h, d. */
  every(interval: string): ScheduleTriggerSource {
    return Object.freeze({ kind: "schedule", name: "flows.tick", intervalMs: everyToMs(interval), epochMs: 0 });
  },
});

/** 64-bit FNV-1a over UTF-8, as 16 hex characters. Dependency-free; not a security hash, an identity. */
function fnv1a64(text: string): string {
  let hi = 0xcbf29ce4, lo = 0x84222325;
  for (const byte of new TextEncoder().encode(text)) {
    lo ^= byte;
    // (hi:lo) * 0x100000001b3 mod 2^64, in 16-bit limbs to stay exact in doubles.
    const l0 = lo & 0xffff, l1 = lo >>> 16, h0 = hi & 0xffff, h1 = hi >>> 16;
    let a = l0 * 0x01b3;
    let b = l1 * 0x01b3 + (a >>> 16);
    let c = h0 * 0x01b3 + (b >>> 16) + l0;
    let d = h1 * 0x01b3 + (c >>> 16) + l1;
    lo = ((b & 0xffff) << 16 | (a & 0xffff)) >>> 0;
    hi = ((d & 0xffff) << 16 | (c & 0xffff)) >>> 0;
  }
  return hi.toString(16).padStart(8, "0") + lo.toString(16).padStart(8, "0");
}

/**
 * The `schedule_id` a flow's schedule subscribes to. Deterministic from the
 * flow name and the declaration, so the local runner, `flows check` and the
 * journal all name the same slot stream without a registry — and injective:
 * a readable slug for humans, plus a hash of the exact declaration so
 * `1-5` and `1,5`, or two zones, or two long names sharing a prefix, never
 * share a stream (the kernel dispatches an event to its first matching
 * subscription only).
 */
export function scheduleIdFor(flowName: string, source: ScheduleTriggerSource): string {
  const canonical = JSON.stringify([flowName, source.cron ?? null, source.tz ?? null, source.intervalMs ?? null, source.epochMs ?? null]);
  const spec = source.cron !== undefined
    ? `cron-${source.cron}${source.tz === undefined ? "" : `-${source.tz}`}`
    : `every-${source.intervalMs}ms`;
  const slug = `${flowName}-${spec}`.toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-|-$/gu, "").slice(0, 96);
  return `${slug}-${fnv1a64(canonical)}`;
}
