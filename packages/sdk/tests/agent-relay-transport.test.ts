import { createHash } from "node:crypto";
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  runAgentRelayTask,
  readAgentRelayEnv,
  type AgentRelayTaskRequest,
} from "../src/agent-relay-transport.js";

const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await Promise.all(
    directories
      .splice(0)
      .map((path) => rm(path, { recursive: true, force: true })),
  );
});
const ok = (data: unknown) =>
  new Response(JSON.stringify({ ok: true, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

async function fixture() {
  const dataDir = await mkdtemp(join(tmpdir(), "flows-relay-task-"));
  directories.push(dataDir);
  const request: AgentRelayTaskRequest = {
    cli: "claude",
    task: "return output",
    runId: "run",
    stepId: "step",
    idempotencyKey: "journal-key",
    dataDir,
  };
  const invocationId =
    "inv_idem_" +
    createHash("sha256")
      .update(
        [
          "action-invoke-v1",
          "workspace",
          "caller",
          "task.run",
          "journal-key",
        ].join("\0"),
      )
      .digest("hex");
  let input: Record<string, unknown>;
  let status = "completed";
  let caller = "caller";
  let result: unknown = { answer: 42 };
  let generation = "generation-1";
  let losePost = false;
  const deadline = new Date(Date.now() + 86400000).toISOString();
  let reads = 0;
  const frames: { url: string; init?: RequestInit }[] = [];
  const fetchMock = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      const address = String(url);
      frames.push({ url: address, init });
      expect((init?.headers as Record<string, string>).authorization).toBe(
        "Bearer fixture-agent-token",
      );
      expect(init?.redirect).toBe("error");
      if (address.endsWith("/v1/agent"))
        return ok({
          id: caller,
          workspace_id: "workspace",
          name: "caller-name",
        });
      if (address.endsWith("/v1/workspace")) return ok({ id: "workspace" });
      if (address.endsWith("/invoke")) {
        expect(init?.method).toBe("POST");
        expect(
          (init?.headers as Record<string, string>)["Idempotency-Key"],
        ).toBe("journal-key");
        input = JSON.parse(String(init?.body)).input;
        if (losePost) throw new Error("response lost after engine commit");
        return ok({
          invocation_id: invocationId,
          action_name: "task.run",
          input,
          status: "completed",
        });
      }
      expect(address).toBe(
        `https://cast.agentrelay.com/v1/actions/task.run/invocations/${invocationId}`,
      );
      reads++;
      return ok({
        invocation_id: invocationId,
        action_name: "task.run",
        caller_id: "caller",
        input,
        status,
        task_execution: {
          execution_id: `${invocationId}/1`,
          run_id: "run",
          step_id: "step",
          dispatch_id: "journal-key",
          deadline,
          ...(status === "pending"
            ? {}
            : {
                worker_generation: generation,
                accepted_at: "2026-01-01T00:00:00.000Z",
              }),
          accounting: { tokens_input: 7, tokens_output: 3 },
        },
        output: status === "completed" ? result : null,
        error: status === "failed" ? "task_deadline_exceeded" : null,
        completed_at: ["completed", "failed"].includes(status)
          ? "2026-01-01T00:00:01.000Z"
          : null,
      });
    },
  );
  return {
    request,
    fetchMock,
    frames,
    invocationId,
    run: (signal?: AbortSignal) =>
      runAgentRelayTask(request, {
        agentToken: "fixture-agent-token",
        fetch: fetchMock as typeof fetch,
        pollMs: 1,
        signal,
      }),
    setStatus: (value: string) => {
      status = value;
    },
    setCaller: (value: string) => {
      caller = value;
    },
    setOutput: (value: unknown) => {
      result = value;
    },
    setGeneration: (value: string) => {
      generation = value;
    },
    losePost: () => {
      losePost = true;
    },
    get reads() {
      return reads;
    },
    posts: () => frames.filter((frame) => frame.init?.method === "POST"),
  };
}

describe("durable Relay task transport", () => {
  it("requires an agent token; a workspace key is not an invocation credential", () => {
    expect(() =>
      readAgentRelayEnv({ RELAY_API_KEY: "fixture-workspace-key" }),
    ).toThrow(/RELAY_AGENT_TOKEN/);
    expect(readAgentRelayEnv({ RELAY_AGENT_TOKEN: " token " })).toEqual({
      agentToken: "token",
      baseUrl: "https://cast.agentrelay.com",
    });
  });
  it("uses supported routes and snake_case data envelopes, returning only final GET output", async () => {
    const f = await fixture();
    const receipt = await f.run();
    expect(receipt.output).toEqual({ answer: 42 });
    expect(receipt.status).toBe("completed");
    expect(f.posts()).toHaveLength(1);
    expect(f.reads).toBe(1);
    expect(
      JSON.parse(String(f.posts()[0]!.init!.body)).input.task_context,
    ).toEqual({
      run_id: "run",
      step_id: "step",
      dispatch_id: "journal-key",
      timeout_ms: 86400000,
    });
  });
  it("keeps readiness/interim states pending even when the POST acknowledgment says completed", async () => {
    const f = await fixture();
    f.setStatus("running");
    let settled = false;
    const running = f.run().then((value) => {
      settled = true;
      return value;
    });
    await vi.waitFor(() => expect(f.reads).toBeGreaterThan(1));
    expect(settled).toBe(false);
    f.setStatus("completed");
    expect((await running).output).toEqual({ answer: 42 });
  });
  it("reconciles an ambiguous POST exclusively by GET without issuing another POST", async () => {
    const f = await fixture();
    f.losePost();
    expect((await f.run()).status).toBe("completed");
    expect(f.posts()).toHaveLength(1);
    expect(f.reads).toBe(1);
  });
  it("reopens the durable dispatch after interruption and reads the original task", async () => {
    const f = await fixture();
    f.setStatus("running");
    const abort = new AbortController();
    const running = f.run(abort.signal);
    const rejection = expect(running).rejects.toThrow();
    await vi.waitFor(() => expect(f.reads).toBeGreaterThan(0));
    abort.abort(new Error("lease lost"));
    await rejection;
    f.setStatus("completed");
    expect((await f.run()).status).toBe("completed");
    expect(f.posts()).toHaveLength(1);
  });
  it("refuses changed caller, canonical endpoint, or input before another invocation", async () => {
    const f = await fixture();
    await f.run();
    f.setCaller("replacement");
    await expect(f.run()).rejects.toThrow(/durable caller/);
    f.setCaller("caller");
    f.request.task = "changed";
    await expect(f.run()).rejects.toThrow(/durable caller/);
    f.request.task = "return output";
    await expect(
      runAgentRelayTask(f.request, {
        baseUrl: "https://other.example",
        agentToken: "fixture-agent-token",
        fetch: f.fetchMock as typeof fetch,
      }),
    ).rejects.toThrow(/durable caller/);
    expect(f.posts()).toHaveLength(1);
  });
  it("recovers an old terminal receipt without redispatch after its reconciliation deadline", async () => {
    const f = await fixture();
    await f.run();
    const directory = join(f.request.dataDir, "relay-tasks");
    const [name] = await readdir(directory);
    const path = join(directory, name!);
    const claim = JSON.parse(await readFile(path, "utf8"));
    claim.startedAt = Date.now() - 2 * 86400000;
    await writeFile(path, JSON.stringify(claim));
    expect((await f.run()).status).toBe("completed");
    expect(f.posts()).toHaveLength(1);
  });
  it("fails on corrupt durable state rather than discarding it and replaying", async () => {
    const f = await fixture();
    await f.run();
    const directory = join(f.request.dataDir, "relay-tasks");
    const [name] = await readdir(directory);
    await writeFile(join(directory, name!), "{");
    await expect(f.run()).rejects.toThrow();
    expect(f.posts()).toHaveLength(1);
  });
  it("refuses before POST when the durable dispatch cannot be written", async () => {
    const f = await fixture();
    const file = join(f.request.dataDir, "not-a-directory");
    await writeFile(file, "fixture");
    f.request.dataDir = file;
    await expect(f.run()).rejects.toThrow();
    expect(f.posts()).toHaveLength(0);
  });
  it("preserves explicit terminal failure and scalar/array/null output", async () => {
    const f = await fixture();
    f.setStatus("failed");
    expect((await f.run()).error).toBe("task_deadline_exceeded");
    for (const output of [null, 42, "text", [1, 2]]) {
      const next = await fixture();
      next.setOutput(output);
      expect((await next.run()).output).toEqual(output);
    }
  });
  it("rejects a changed accepted generation instead of accepting a stale terminal receipt", async () => {
    const f = await fixture();
    f.setStatus("running");
    const running = f.run();
    const rejection = expect(running).rejects.toThrow(/generation/);
    await vi.waitFor(() => expect(f.reads).toBeGreaterThan(0));
    f.setGeneration("replacement");
    f.setStatus("completed");
    await rejection;
  });
  it("rejects wrong correlation and masks arbitrary HTTP error bodies", async () => {
    const f = await fixture();
    await expect(
      runAgentRelayTask(f.request, {
        agentToken: "fixture-token",
        fetch: vi.fn(
          async () => new Response("secret-response-body", { status: 401 }),
        ) as typeof fetch,
      }),
    ).rejects.toThrow("HTTP 401");
    const changed = vi.fn(
      async (url: string | URL | Request, init?: RequestInit) => {
        const response = await f.fetchMock(url, init);
        const body = (await response.json()) as {
          data: { task_execution: { dispatch_id: string } };
        };
        if (String(url).includes("/invocations/"))
          body.data.task_execution.dispatch_id = "wrong";
        return new Response(JSON.stringify(body), { status: 200 });
      },
    );
    await expect(
      runAgentRelayTask(f.request, {
        agentToken: "fixture-agent-token",
        fetch: changed as typeof fetch,
      }),
    ).rejects.toThrow(/correlation/);
  });
});

import { EventEmitter } from "node:events";
import type { JournalClient } from "../src/journal-client.js";
import type { StepDispatchEvent } from "../src/protocol.js";
import { AgentWorker } from "../src/worker.js";

async function workerFixture(f: Awaited<ReturnType<typeof fixture>>) {
  vi.stubEnv("RELAY_AGENT_TOKEN", "fixture-agent-token");
  vi.stubEnv("RELAY_BASE_URL", "https://cast.agentrelay.com");
  vi.stubGlobal("fetch", f.fetchMock);
  const client = Object.assign(new EventEmitter(), {
    workerAttach: vi.fn(async () => ({})),
    stepHeartbeat: vi.fn(async () => ({
      lease_deadline_ms: Date.now() + 30000,
    })),
    stepComplete: vi.fn(async (..._args: unknown[]) => ({})),
  });
  const worker = new AgentWorker(client as unknown as JournalClient, {
    workerId: "fixture-worker",
    pins: {},
    dataDir: f.request.dataDir,
  });
  const errors: unknown[] = [];
  worker.on("error", (error) => errors.push(error));
  await worker.attach();
  const dispatch: StepDispatchEvent = {
    run_id: "run",
    step_id: "step",
    attempt: 1,
    step_type: "agent",
    spec: {
      cli: "claude",
      instruction: "return output",
      transport: "relay",
      model: "codex-medium",
      verification: { json_schema: { type: "array" } },
    },
    idempotency_key: "journal-key",
    lease_id: "lease",
    lease_deadline_ms: Date.now() + 30000,
    pins: {},
    wake_context: { triggering_event: { type: "fixture" } },
  };
  return { client, worker, errors, dispatch };
}

describe("Relay completion at the journal boundary", () => {
  it("does not complete at readiness and journals exact output, receipt, and priced accounting", async () => {
    const f = await fixture();
    f.setStatus("running");
    f.setOutput([1, 2]);
    const w = await workerFixture(f);
    w.client.emit("step.dispatch", w.dispatch);
    await vi.waitFor(() => expect(f.reads).toBe(1));
    expect(w.client.stepComplete).not.toHaveBeenCalled();
    f.setStatus("completed");
    await w.worker.close();
    expect(w.errors).toEqual([]);
    expect(w.client.stepComplete).toHaveBeenCalledTimes(1);
    expect(w.client.stepComplete.mock.calls[0]).toEqual([
      "run",
      "step",
      1,
      "journal-key",
      "success",
      expect.objectContaining({
        output: [1, 2],
        usage: { tokens_in: 7, tokens_out: 3, dollars: "0.000038" },
        trajectory_tail: {
          relay_task: expect.objectContaining({
            invocation_id: f.invocationId,
            status: "completed",
          }),
        },
      }),
    ]);
    const input = JSON.parse(String(f.posts()[0]!.init!.body)).input;
    expect(input.task).toContain("Wake context (journaled)");
    expect(input.task).toContain("final=true");
    expect(input.result_schema).toEqual({ type: "array" });
  });
  it("journals terminal task failure as worker_error with its explicit reason", async () => {
    const f = await fixture();
    f.setStatus("failed");
    const w = await workerFixture(f);
    w.client.emit("step.dispatch", w.dispatch);
    await w.worker.close();
    expect(w.errors).toEqual([]);
    expect(w.client.stepComplete.mock.calls[0]![4]).toBe("worker_error");
    expect(JSON.stringify(w.client.stepComplete.mock.calls[0])).toContain(
      "task_deadline_exceeded",
    );
  });
  it("aborts polling on rejected renewal and never writes a stale completion", async () => {
    const f = await fixture();
    f.setStatus("running");
    const w = await workerFixture(f);
    w.client.stepHeartbeat
      .mockResolvedValueOnce({ lease_deadline_ms: Date.now() + 150 })
      .mockRejectedValueOnce(new Error("lease replaced"));
    w.client.emit("step.dispatch", w.dispatch);
    await w.worker.close();
    expect(w.client.stepComplete).not.toHaveBeenCalled();
    expect(String(w.errors[0])).toContain("lease replaced");
    expect(f.posts()).toHaveLength(1);
  });
});

import { readFile } from "node:fs/promises";
it("matches exact HTTP fixtures generated by Relaycast #436, including its deterministic invocation ID", async () => {
  const wire = JSON.parse(
    await readFile(
      new URL("./fixtures/relay-task/relaycast-436.json", import.meta.url),
      "utf8",
    ),
  );
  const f = await fixture();
  let reads = 0;
  const fetchMock = vi.fn(
    async (url: string | URL | Request, init?: RequestInit) => {
      if (String(url).endsWith("/v1/agent"))
        return new Response(JSON.stringify(wire.identity), { status: 200 });
      if (String(url).endsWith("/invoke")) {
        expect(JSON.parse(String(init?.body))).toEqual({ input: wire.input });
        return new Response(JSON.stringify(wire.ack), { status: 201 });
      }
      expect(String(url)).toBe(
        `https://cast.agentrelay.com/v1/actions/task.run/invocations/${wire.ack.data.invocation_id}`,
      );
      return new Response(
        JSON.stringify(
          [wire.dispatched, wire.running, wire.completed][reads++],
        ),
        { status: 200 },
      );
    },
  );
  const result = await runAgentRelayTask(f.request, {
    agentToken: "fixture-token",
    fetch: fetchMock as typeof fetch,
    pollMs: 1,
  });
  expect(result.output).toEqual(wire.completed.data.output);
  expect(result.task_execution).toEqual(wire.completed.data.task_execution);
  expect(reads).toBe(3);
});
