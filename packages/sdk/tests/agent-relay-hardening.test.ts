import { readFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { runAgentRelayTask } from "../src/agent-relay-transport.js";
import { readTaskReceipt } from "../src/agent-relay-receipt.js";

const wire = JSON.parse(
  await readFile(
    new URL("./fixtures/relay-task/relaycast-436.json", import.meta.url),
    "utf8",
  ),
);
const id = wire.ack.data.invocation_id;
const request = {
  cli: "claude",
  task: "fixture",
  runId: "run",
  stepId: "step",
  idempotencyKey: "key",
  dataDir: "/unused",
};

describe("Relay credential origin", () => {
  for (const baseUrl of [
    "http://cast.agentrelay.com",
    "http://192.168.1.1",
    "http://localhost.example",
    "http://127.0.0.1.example",
  ]) {
    it(`refuses bearer credentials at ${baseUrl} before any request`, async () => {
      const fetchMock = vi.fn();
      await expect(
        runAgentRelayTask(request, {
          baseUrl,
          agentToken: "fixture-token",
          fetch: fetchMock,
        }),
      ).rejects.toThrow(/require HTTPS/);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  }
  for (const baseUrl of [
    "https://cast.agentrelay.com",
    "http://127.0.0.1:1234",
    "http://127.9.8.7:1234",
    "http://[::1]:1234",
  ]) {
    it(`allows ${baseUrl} to reach the authenticated identity check`, async () => {
      const fetchMock = vi.fn(async () => new Response("", { status: 401 }));
      await expect(
        runAgentRelayTask(request, {
          baseUrl,
          agentToken: "fixture-token",
          fetch: fetchMock,
        }),
      ).rejects.toThrow("HTTP 401");
      expect(fetchMock).toHaveBeenCalledOnce();
    });
  }
});

describe("Relay acceptance identity", () => {
  it("allows generation and acceptance time to appear once on the same execution", () => {
    const pending = readTaskReceipt(wire.dispatched.data, id, wire.input);
    expect(
      readTaskReceipt(wire.running.data, id, wire.input, pending).status,
    ).toBe("running");
  });
  it("refuses an execution change before the generation exists", () => {
    const pending = readTaskReceipt(wire.dispatched.data, id, wire.input);
    const changed = structuredClone(wire.running.data);
    changed.task_execution.execution_id += "/replacement";
    expect(() => readTaskReceipt(changed, id, wire.input, pending)).toThrow(
      /changed its execution/,
    );
  });
  for (const field of ["worker_generation", "accepted_at"]) {
    it(`refuses changed or removed ${field} after acceptance`, () => {
      const running = readTaskReceipt(wire.running.data, id, wire.input);
      const changed = structuredClone(wire.completed.data);
      changed.task_execution[field] =
        field === "accepted_at" ? "2026-01-01T00:00:00.000Z" : "replacement";
      expect(() => readTaskReceipt(changed, id, wire.input, running)).toThrow(
        /changed its execution/,
      );
      delete changed.task_execution[field];
      expect(() => readTaskReceipt(changed, id, wire.input, running)).toThrow(
        /acceptance/,
      );
    });
  }
});
