import { describe, expect, expectTypeOf, it } from "vitest";
import {
  flow,
  type Ctx,
  type FlowHandle,
} from "@relayflows/surface";
import { getFlowDefinition } from "@relayflows/surface/runtime";

describe("flow", () => {
  it("defines a flow with the empty header as the default", () => {
    const body = async (_f: Ctx): Promise<void> => undefined;
    const definition = flow("release-note", body);

    expect(definition).toEqual({ name: "release-note" });
    expect(Object.isFrozen(definition)).toBe(true);
  });

  it("accepts an explicit escalation header", () => {
    const header = {
      identity: "release-bot",
      tools: { mcp: ["github"] },
    };
    const definition = flow(
      "release-note",
      header,
      async () => undefined,
    );

    expect(definition).toEqual({ name: "release-note" });
    header.identity = "mutated-after-definition";
    header.tools.mcp.push("slack");
    expect(getFlowDefinition(definition).header).toEqual({
      identity: "release-bot",
      tools: { mcp: ["github"] },
    });
    expect(Object.isFrozen(getFlowDefinition(definition).header)).toBe(true);
    expect(Object.isFrozen(getFlowDefinition(definition).header.tools?.mcp)).toBe(true);
  });

  it("retains the body for an authorized runtime without executing it", async () => {
    let bodyRan = false;
    const definition = flow("deferred", async () => {
      bodyRan = true;
    });

    expectTypeOf(definition).toEqualTypeOf<FlowHandle>();
    expect(bodyRan).toBe(false);
    expect(definition).not.toHaveProperty("run");
    expect(definition).not.toHaveProperty("client");
    expect(definition).not.toHaveProperty("body");

    const authored = getFlowDefinition(definition);
    expect(Object.isFrozen(authored)).toBe(true);
    await authored.body({} as Ctx);
    expect(bodyRan).toBe(true);
  });

  it("refuses counterfeit handles at the runtime boundary", () => {
    expect(() => getFlowDefinition({ name: "counterfeit" })).toThrow(
      "expected an @relayflows/surface flow handle",
    );

    const definitionSymbol = Symbol.for(
      "@relayflows/surface.authored-definition.v1",
    );
    const forgedValues = [
      "not-a-definition",
      Object.freeze({
        name: "counterfeit",
        header: Object.freeze({}),
        body: "not-callable",
      }),
      Object.freeze({
        name: "different-name",
        header: Object.freeze({}),
        body: async () => undefined,
      }),
      Object.freeze({
        name: "counterfeit",
        header: {},
        body: async () => undefined,
      }),
      {
        name: "counterfeit",
        header: Object.freeze({}),
        body: async () => undefined,
      },
    ];

    for (const forgedDefinition of forgedValues) {
      const forged = { name: "counterfeit" };
      Object.defineProperty(forged, definitionSymbol, {
        value: forgedDefinition,
        enumerable: false,
        configurable: false,
        writable: false,
      });
      expect(() => getFlowDefinition(Object.freeze(forged))).toThrow(
        "expected an @relayflows/surface flow handle",
      );
    }
  });
});
