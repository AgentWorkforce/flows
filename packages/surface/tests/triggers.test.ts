import { describe, expect, it } from "vitest";
import { flow, webhook, type Ctx, type WebhookFilter } from "@relayflows/surface";
import { getFlowDefinition } from "@relayflows/surface/runtime";

describe("webhook declarations", () => {
  it("records handlers without executing them and preserves immutable chains", async () => {
    const events: unknown[] = [];
    const body = async (_f: Ctx, event: unknown): Promise<void> => { events.push(event); };
    const base = flow("chief", { identity: "chief" });
    const first = base.on(webhook("release"), body);
    const second = first.on(webhook("deploy"), body);
    expect(getFlowDefinition(base).handlers).toEqual([]);
    expect(getFlowDefinition(first).handlers).toEqual([{ trigger: { kind: "webhook", name: "release" }, body }]);
    expect(getFlowDefinition(second).handlers).toHaveLength(2);
    expect(Object.isFrozen(getFlowDefinition(second).handlers)).toBe(true);
    expect(events).toEqual([]);
    await getFlowDefinition(first).handlers[0]!.body({} as Ctx, { tag: "v1" });
    expect(events).toEqual([{ tag: "v1" }]);
  });

  it("keeps direct bodies distinct from event handlers", () => {
    const direct = async (): Promise<void> => undefined;
    const handler = async (): Promise<void> => undefined;
    const declared = flow("both", direct).on(webhook("release"), handler);
    expect(getFlowDefinition(declared).body).toBe(direct);
    expect(getFlowDefinition(declared).handlers[0]!.body).toBe(handler);
  });

  it("snapshots and deeply freezes filter data", () => {
    const filter = { action: "released", nested: { tags: ["a"] } };
    const source = webhook("release", filter);
    filter.nested.tags.push("b");
    expect(source.filter).toEqual({ action: "released", nested: { tags: ["a"] } });
    expect(Object.isFrozen(source.filter?.nested)).toBe(true);
    expect(JSON.parse(JSON.stringify(source))).toEqual(source);
  });

  it("refuses paths, non-data filters, and invalid handlers", () => {
    for (const name of ["", ".", "..", "a/b", "a%2fb", "a\\b", "a b"]) {
      expect(() => webhook(name)).toThrow();
    }
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const filter of [null, [], { x: undefined }, { x: NaN }, { x: new Date() }, circular,
      Object.defineProperty({}, "x", { get: () => { throw new Error("getter executed"); } })]) {
      expect(() => webhook("release", filter as WebhookFilter)).toThrow(/webhook filter/);
    }
    expect(() => flow("empty").on(webhook("release"), undefined as never)).toThrow("requires a body");
  });
});
