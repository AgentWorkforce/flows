import { describe, expect, expectTypeOf, it } from "vitest";
import {
  flow,
  type CompletionReason,
  type Ctx,
  type FlowHandle,
  type FlowHeader,
  type RunCompletionReason,
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

  it("validates raw header keys and nested values before cloning", () => {
    const invalidHeaders: { value: unknown; message: string }[] = [
      {
        value: { identitty: "release-bot" },
        message: 'header: unknown field "identitty"',
      },
      {
        value: { identity: 42 },
        message: "header.identity: expected a string",
      },
      {
        value: { memory: { typo: true } },
        message: 'header.memory: unknown field "typo"',
      },
      {
        value: { memory: { script: "yes" } },
        message: "header.memory.script: expected a boolean",
      },
      {
        value: { tools: { typo: [] } },
        message: 'header.tools: unknown field "typo"',
      },
      {
        value: { tools: { mcp: ["github", 42] } },
        message: "header.tools.mcp: expected an array of strings",
      },
      {
        value: [],
        message: "header: expected an object",
      },
      {
        value: null,
        message: "header: expected an object",
      },
      {
        value: { memory: null },
        message: "header.memory: expected an object",
      },
      {
        value: { tools: null },
        message: "header.tools: expected an object",
      },
      {
        value: { tools: { mcp: "github" } },
        message: "header.tools.mcp: expected an array of strings",
      },
      {
        value: Object.create({ identity: "inherited" }),
        message: "header: expected a plain object",
      },
      {
        value: Object.defineProperty({}, "identity", { get: () => "hidden" }),
        message: "header.identity: expected a data property",
      },
    ];

    for (const invalid of invalidHeaders) {
      expect(() => flow(
        "invalid-header",
        invalid.value as FlowHeader,
        async () => undefined,
      )).toThrow(invalid.message);
    }
  });

  it("uses run reasons for done while keeping step reasons distinct", () => {
    expectTypeOf<Parameters<Ctx["done"]>[0]>()
      .toEqualTypeOf<RunCompletionReason>();
    expectTypeOf<CompletionReason>()
      .not.toEqualTypeOf<RunCompletionReason>();

    const typeGate = (f: Ctx): void => {
      f.done("step_failed");
      // @ts-expect-error worker_error is a step reason, not a run reason.
      f.done("worker_error");
    };
    void typeGate;
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
    await authored.body({} as Ctx, undefined);
    expect(bodyRan).toBe(true);
  });

  it("passes direct-run input to the authored body", async () => {
    const definition = flow<{ message: string }>("direct", {}, async (_f, input) => {
      expect(input.message).toBe("from-cli");
    });

    await getFlowDefinition(definition).body({} as Ctx, { message: "from-cli" });
  });
  it("refuses malformed and forged handles at the runtime boundary", () => {
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

    const completeForgery = { name: "counterfeit" };
    Object.defineProperty(completeForgery, definitionSymbol, {
      value: Object.freeze({
        name: "counterfeit",
        header: Object.freeze({}),
        body: async () => undefined,
      }),
      enumerable: false,
      configurable: false,
      writable: false,
    });
    expect(() => getFlowDefinition(Object.freeze(completeForgery))).toThrow(
      "expected an @relayflows/surface flow handle",
    );
    const genuine = flow("genuine", async () => undefined);
    const reflectedSymbols = Object.getOwnPropertySymbols(genuine);
    expect(reflectedSymbols).toEqual([]);

    const reflectedForgery = { name: "reflected-forgery" };
    for (const symbol of reflectedSymbols) {
      Object.defineProperty(reflectedForgery, symbol, {
        value: Object.freeze({
          name: "reflected-forgery",
          header: Object.freeze({}),
          body: async () => undefined,
        }),
        enumerable: false,
        configurable: false,
        writable: false,
      });
    }
    expect(() => getFlowDefinition(Object.freeze(reflectedForgery))).toThrow(
      "expected an @relayflows/surface flow handle",
    );
  });
});
