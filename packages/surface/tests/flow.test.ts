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

  it("accepts named agent declarations and freezes them deeply", () => {
    const header = {
      agents: {
        reviewer: { cli: "claude", model: "claude-sonnet-4-6" },
        fixer: { cli: "codex", model: "gpt-5-codex" },
      },
    };
    const definition = flow(
      "multi-agent",
      header,
      async () => undefined,
    );

    header.agents.reviewer.model = "mutated-after-definition";
    expect(getFlowDefinition(definition).header).toEqual({
      agents: {
        reviewer: { cli: "claude", model: "claude-sonnet-4-6" },
        fixer: { cli: "codex", model: "gpt-5-codex" },
      },
    });
    const frozenAgents = getFlowDefinition(definition).header.agents;
    expect(Object.isFrozen(frozenAgents)).toBe(true);
    expect(Object.isFrozen(frozenAgents?.reviewer)).toBe(true);
  });

  it("rejects an accessor property on the agents map instead of invoking it", () => {
    // A getter can legally answer validation with one value and a second,
    // separate read (freezing) with a different one — reads must go through
    // property descriptors, which reject accessors outright, rather than
    // trusting a stateful getter to answer the same way twice.
    let reads = 0;
    const agents: Record<string, unknown> = {};
    Object.defineProperty(agents, "reviewer", {
      enumerable: true,
      get() {
        reads += 1;
        return reads === 1
          ? { cli: "checked-cli", model: "model-a" }
          : { cli: 42, model: "model-b", permissions: "write-all" };
      },
    });

    expect(() => flow(
      "getter-map",
      { agents } as unknown as FlowHeader,
      async (f) => f.done("success"),
    )).toThrow("header.agents.reviewer: expected a data property");
    expect(reads).toBe(0);
  });

  it("requires named agent declaration values and names to be trimmed", () => {
    const trimCases: { value: unknown; message: string }[] = [
      {
        value: { agents: { reviewer: { cli: " claude", model: "m" } } },
        message: "header.agents.reviewer.cli: must not have leading or trailing whitespace",
      },
      {
        value: { agents: { reviewer: { cli: "claude ", model: "m" } } },
        message: "header.agents.reviewer.cli: must not have leading or trailing whitespace",
      },
      {
        value: { agents: { reviewer: { cli: "claude", model: " m" } } },
        message: "header.agents.reviewer.model: must not have leading or trailing whitespace",
      },
      {
        value: { agents: { " reviewer": { cli: "claude", model: "m" } } },
        message: 'header.agents: agent name " reviewer" must be a non-empty, trimmed string',
      },
    ];
    for (const trimCase of trimCases) {
      expect(() => flow(
        "untrimmed-agent",
        trimCase.value as FlowHeader,
        async () => undefined,
      )).toThrow(trimCase.message);
    }
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
        value: { agents: { reviewer: { cli: "claude" } } },
        message: "header.agents.reviewer.model: expected a non-empty string",
      },
      {
        value: { agents: { reviewer: { model: "claude-sonnet-4-6" } } },
        message: "header.agents.reviewer.cli: expected a non-empty string",
      },
      {
        value: { agents: { reviewer: { cli: "claude", model: "" } } },
        message: "header.agents.reviewer.model: expected a non-empty string",
      },
      {
        value: { agents: { reviewer: { cli: "claude", model: "m", typo: true } } },
        message: 'header.agents.reviewer: unknown field "typo"',
      },
      {
        value: { agents: { reviewer: "claude" } },
        message: "header.agents.reviewer: expected an object",
      },
      {
        value: { agents: "reviewer" },
        message: "header.agents: expected an object",
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
