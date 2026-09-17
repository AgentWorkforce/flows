import { describe, expect, it } from "vitest";
import { flow } from "../src/flow.js";
import { getFlowDefinition } from "../src/runtime.js";
import { cronFixedIntervalMs, cronGrid, cronMaxGapMs, everyToMs, parseCron, schedule, scheduleIdFor } from "../src/schedule.js";

describe("schedule.every", () => {
  it("parses s/m/h/d intervals and refuses sub-second or malformed ones", () => {
    expect(everyToMs("5m")).toBe(300_000);
    expect(everyToMs("2h")).toBe(7_200_000);
    expect(everyToMs("1d")).toBe(86_400_000);
    expect(everyToMs("30s")).toBe(30_000);
    for (const bad of ["0s", "5", "5 m", "m5", "1.5m", "", "5w"]) {
      expect(() => everyToMs(bad), bad).toThrow(TypeError);
    }
    expect(schedule.every("5m")).toEqual({ kind: "schedule", name: "flows.tick", intervalMs: 300_000, epochMs: 0 });
    expect(Object.isFrozen(schedule.every("5m"))).toBe(true);
  });
});

describe("schedule.cron", () => {
  it("accepts standard five-field expressions, names, lists, ranges and steps", () => {
    for (const ok of ["* * * * *", "*/5 * * * *", "0 9 * * 1-5", "30 6 1,15 * *", "0 0 * jan,jul mon", "15 */2 * * *"]) {
      expect(() => parseCron(ok), ok).not.toThrow();
    }
    expect(parseCron("0 9 * * 1-5")).toEqual({ minute: "0", hour: "9", dayOfMonth: "*", month: "*", dayOfWeek: "1-5" });
  });

  it("refuses the wrong field count, out-of-range values and bad steps", () => {
    for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "1-2-3 * * * *", "0 9 * * fri-xyz", "*/5/2 * * * *", "1,,2 * * * *", "* * * * * *"]) {
      expect(() => parseCron(bad), bad).toThrow(TypeError);
    }
  });

  it("derives a tick grid (period + phase) only when one reproduces the cron exactly", () => {
    expect(cronGrid(parseCron("*/5 * * * *"))).toEqual({ intervalMs: 300_000, epochMs: 0 });
    expect(cronGrid(parseCron("* * * * *"))).toEqual({ intervalMs: 60_000, epochMs: 0 });
    expect(cronGrid(parseCron("0 */2 * * *"))).toEqual({ intervalMs: 7_200_000, epochMs: 0 });
    // Phase: fires at :15, not on the hour; at 06:30 UTC, not midnight.
    expect(cronGrid(parseCron("15 * * * *"))).toEqual({ intervalMs: 3_600_000, epochMs: 900_000 });
    expect(cronGrid(parseCron("30 6 * * *"))).toEqual({ intervalMs: 86_400_000, epochMs: 23_400_000 });
    expect(cronGrid(parseCron("15 */6 * * *"))).toEqual({ intervalMs: 21_600_000, epochMs: 900_000 });
    // Not grids: cron restarts */7 every hour; a grid would drift. Lists, ranges, day fields, non-UTC zones.
    for (const notGrid of ["*/7 * * * *", "0 */5 * * *", "0 9 * * 1-5", "0,30 * * * *", "*/5 9 * * *", "0 0 1 * *", "1-5 * * * *"]) {
      expect(cronGrid(parseCron(notGrid)), notGrid).toBeUndefined();
      expect(cronFixedIntervalMs(parseCron(notGrid)), notGrid).toBeUndefined();
    }
    expect(cronGrid(parseCron("*/5 * * * *"), "Europe/Oslo")).toBeUndefined();
    expect(cronGrid(parseCron("*/5 * * * *"), "UTC")).toEqual({ intervalMs: 300_000, epochMs: 0 });
    expect(schedule.cron("*/10 * * * *")).toEqual({ kind: "schedule", name: "flows.tick", cron: "*/10 * * * *", intervalMs: 600_000, epochMs: 0 });
    expect(schedule.cron("0 9 * * 1-5", { tz: "Europe/Oslo" })).toEqual({ kind: "schedule", name: "flows.tick", cron: "0 9 * * 1-5", tz: "Europe/Oslo" });
    expect(schedule.cron("  0   9 * * 1-5 ").cron).toBe("0 9 * * 1-5");
    expect(() => schedule.cron("0 9 * * *", { tz: "Mars/Olympus" })).toThrow(/IANA/u);
  });

  it("measures a cron's longest quiet period so a silence budget can be declared honestly", () => {
    const h = 3_600_000;
    expect(cronMaxGapMs(parseCron("0 9 * * 1-5"))).toBe(72 * h);   // Friday 09:00 → Monday 09:00
    expect(cronMaxGapMs(parseCron("0 9 * * *"))).toBe(24 * h);
    expect(cronMaxGapMs(parseCron("*/15 * * * *"))).toBe(h / 4);
    expect(cronMaxGapMs(parseCron("0 0 1 * *"))).toBe(31 * 24 * h);
    expect(cronMaxGapMs(parseCron("0 0 29 2 *"))).toBe(731 * 24 * h); // fires once in the span
    expect(cronMaxGapMs(parseCron("0 0 * * sun"))).toBe(7 * 24 * h);
    // Both day fields restricted: POSIX fires when either matches.
    expect(cronMaxGapMs(parseCron("0 0 1 * mon"))).toBeLessThanOrEqual(7 * 24 * h);
  });
});

describe("schedule ids and flow.on", () => {
  it("derives one deterministic, injective id per flow + declaration", () => {
    const a = scheduleIdFor("nightly report", schedule.cron("0 9 * * 1-5", { tz: "Europe/Oslo" }));
    expect(a).toMatch(/^nightly-report-cron-0-9-1-5-europe-oslo-[0-9a-f]{16}$/u);
    expect(scheduleIdFor("nightly report", schedule.cron("0 9 * * 1-5", { tz: "Europe/Oslo" }))).toBe(a);
    expect(scheduleIdFor("nightly report", schedule.every("5m"))).toMatch(/^nightly-report-every-300000ms-[0-9a-f]{16}$/u);
    // Declarations that slug identically must not share a stream: punctuation, zone, and long names.
    const ids = [
      scheduleIdFor("nightly", schedule.cron("0 9 * * 1-5")),
      scheduleIdFor("nightly", schedule.cron("0 9 * * 1,5")),
      scheduleIdFor("nightly", schedule.cron("0 9 * * 1-5", { tz: "Europe/Oslo" })),
      scheduleIdFor("nightly", schedule.cron("0 9 * * 1-5", { tz: "Europe/Paris" })),
      scheduleIdFor("nightly", schedule.every("5m")),
      scheduleIdFor("nightly", schedule.every("10m")),
      scheduleIdFor("x".repeat(200) + "a", schedule.every("5m")),
      scheduleIdFor("x".repeat(200) + "b", schedule.every("5m")),
    ];
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) expect(id.length).toBeLessThanOrEqual(120);
  });

  it("registers a schedule handler on a flow, re-deriving the source from its declaration", () => {
    const handle = flow("heartbeat").on(schedule.every("1m"), async (f) => f.done("success"));
    const definition = getFlowDefinition(handle);
    expect(definition.handlers).toHaveLength(1);
    expect(definition.handlers[0]!.trigger).toEqual({ kind: "schedule", name: "flows.tick", intervalMs: 60_000, epochMs: 0 });
    const cronHandle = flow("nightly").on(schedule.cron("0 9 * * 1-5", { tz: "UTC" }), async (f) => f.done("success"));
    expect(getFlowDefinition(cronHandle).handlers[0]!.trigger).toEqual({ kind: "schedule", name: "flows.tick", cron: "0 9 * * 1-5", tz: "UTC" });
    // A hand-built object that lies about its interval is refused: only this module's declarations lower.
    expect(() => flow("x").on({ kind: "schedule", name: "flows.tick", intervalMs: 7 } as never, async (f) => f.done("success")))
      .toThrow(TypeError);
    expect(() => flow("x").on({ kind: "schedule", name: "flows.tick", intervalMs: 60_000, epochMs: 5 } as never, async (f) => f.done("success")))
      .toThrow(TypeError);
  });
});
