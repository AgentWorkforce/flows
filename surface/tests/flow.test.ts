import { describe, expect, expectTypeOf, it } from "vitest";
import {
  flow,
  type Ctx,
  type FlowHandle,
} from "@relayflows/surface";

describe("flow", () => {
  it("defines a flow with the empty header as the default", () => {
    const body = async (_f: Ctx): Promise<void> => undefined;
    const definition = flow("release-note", body);

    expect(definition).toEqual({ name: "release-note" });
    expect(Object.isFrozen(definition)).toBe(true);
  });

  it("accepts an explicit escalation header", () => {
    const definition = flow(
      "release-note",
      { identity: "release-bot" },
      async () => undefined,
    );

    expect(definition).toEqual({ name: "release-note" });
  });

  it("keeps execution and journal clients outside the surface package", () => {
    let bodyRan = false;
    const definition = flow("deferred", async () => {
      bodyRan = true;
    });

    expectTypeOf(definition).toEqualTypeOf<FlowHandle>();
    expect(bodyRan).toBe(false);
    expect(definition).not.toHaveProperty("run");
    expect(definition).not.toHaveProperty("client");
    expect(definition).not.toHaveProperty("body");
  });
});
