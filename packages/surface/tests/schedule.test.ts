import { describe, expect, it } from "vitest";
import { flow } from "../src/flow.js";
import { getFlowDefinition } from "../src/runtime.js";
import { cronFixedIntervalMs, everyToMs, parseCron, schedule, scheduleIdFor } from "../src/schedule.js";

describe("schedule.every", () => {
  it("parses s/m/h/d intervals and refuses sub-second or malformed ones", () => {
    expect(everyToMs("5m")).toBe(300_000);
    expect(everyToMs("2h")).toBe(7_200_000);
    expect(everyToMs("1d")).toBe(86_400_000);
    expect(everyToMs("30s")).toBe(30_000);
    for (const bad of ["0s", "5", "5 m", "m5", "1.5m", "", "5w"]) {
      expect(() => everyToMs(bad), bad).toThrow(TypeError);
    }
    expect(schedule.every("5m")).toEqual({ kind: "schedule", name: "flows.tick", intervalMs: 300_000 });
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
    for (const bad of ["* * * *", "60 * * * *", "* 24 * * *", "* * 0 * *", "* * * 13 *", "* * * * 8", "*/0 * * * *", "1-2-3 * * * *", "0 9 * * fri-xyz"]) {
      expect(() => parseCron(bad), bad).toThrow(TypeError);
    }
  });

  it("derives a fixed interval only when the cron really is one", () => {
    expect(cronFixedIntervalMs(parseCron("*/5 * * * *"))).toBe(300_000);
    expect(cronFixedIntervalMs(parseCron("* * * * *"))).toBe(60_000);
    expect(cronFixedIntervalMs(parseCron("0 */2 * * *"))).toBe(7_200_000);
    expect(cronFixedIntervalMs(parseCron("15 * * * *"))).toBe(3_600_000);
    for (const notFixed of ["0 9 * * *", "0 9 * * 1-5", "0,30 * * * *", "*/5 9 * * *", "0 0 1 * *"]) {
      expect(cronFixedIntervalMs(parseCron(notFixed)), notFixed).toBeUndefined();
    }
    expect(schedule.cron("*/10 * * * *")).toEqual({ kind: "schedule", name: "flows.tick", cron: "*/10 * * * *", intervalMs: 600_000 });
    expect(schedule.cron("0 9 * * 1-5", { tz: "Europe/Oslo" })).toEqual({ kind: "schedule", name: "flows.tick", cron: "0 9 * * 1-5", tz: "Europe/Oslo" });
    expect(() => schedule.cron("0 9 * * *", { tz: "Mars/Olympus" })).toThrow(/IANA/u);
  });
});

describe("schedule ids and flow.on", () => {
  it("derives one deterministic id per flow + declaration", () => {
    const a = scheduleIdFor("nightly report", schedule.cron("0 9 * * 1-5", { tz: "Europe/Oslo" }));
    expect(a).toBe("nightly-report-cron-0-9-1-5-europe-oslo");
    expect(scheduleIdFor("nightly report", schedule.cron("0 9 * * 1-5", { tz: "Europe/Oslo" }))).toBe(a);
    expect(scheduleIdFor("nightly report", schedule.every("5m"))).toBe("nightly-report-every-300000ms");
    expect(scheduleIdFor("nightly report", schedule.every("10m"))).not.toBe(scheduleIdFor("nightly report", schedule.every("5m")));
  });

  it("registers a schedule handler on a flow, re-deriving the source from its declaration", () => {
    const handle = flow("heartbeat").on(schedule.every("1m"), async (f) => f.done("success"));
    const definition = getFlowDefinition(handle);
    expect(definition.handlers).toHaveLength(1);
    expect(definition.handlers[0]!.trigger).toEqual({ kind: "schedule", name: "flows.tick", intervalMs: 60_000 });
    const cronHandle = flow("nightly").on(schedule.cron("0 9 * * 1-5", { tz: "UTC" }), async (f) => f.done("success"));
    expect(getFlowDefinition(cronHandle).handlers[0]!.trigger).toEqual({ kind: "schedule", name: "flows.tick", cron: "0 9 * * 1-5", tz: "UTC" });
    // A hand-built object that lies about its interval is refused: only this module's declarations lower.
    expect(() => flow("x").on({ kind: "schedule", name: "flows.tick", intervalMs: 7 } as never, async (f) => f.done("success")))
      .toThrow(TypeError);
  });
});
