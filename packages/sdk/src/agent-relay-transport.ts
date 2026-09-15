import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { claimRelayTask } from "./agent-relay-state.js";
import { canonicalize } from "./canonical.js";
import {
  isRecord,
  nonempty,
  readTaskReceipt,
  type RelayTaskReceipt,
} from "./agent-relay-receipt.js";

export type AgentTransport = "direct" | "relay";
export interface AgentRelayTaskRequest {
  cli: string;
  task: string;
  model?: string;
  worker_cwd?: string;
  result_schema?: unknown;
  runId: string;
  stepId: string;
  idempotencyKey: string;
  dataDir: string;
  /** Engine task contract ceiling; bounded independently of the renewing lease. */
  timeoutMs?: number;
}
export interface AgentRelayEnv {
  baseUrl?: string;
  agentToken?: string;
}
export class AgentRelayTransportError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "AgentRelayTransportError";
  }
}
export function readAgentRelayEnv(
  env: NodeJS.ProcessEnv = process.env,
): Required<AgentRelayEnv> {
  const agentToken = env.RELAY_AGENT_TOKEN?.trim();
  if (!agentToken)
    throw new AgentRelayTransportError(
      "Relay task transport requires a pre-provisioned RELAY_AGENT_TOKEN.",
    );
  return {
    baseUrl: env.RELAY_BASE_URL?.trim() || "https://cast.agentrelay.com",
    agentToken,
  };
}

/** Exact Relaycast #436 HTTP contract. Only terminal GET receipts can return. */
export async function runAgentRelayTask(
  request: AgentRelayTaskRequest,
  options: AgentRelayEnv & {
    fetch?: typeof fetch;
    signal?: AbortSignal;
    pollMs?: number;
  } = {},
): Promise<RelayTaskReceipt> {
  const env = options.agentToken
    ? {
        baseUrl: options.baseUrl || "https://cast.agentrelay.com",
        agentToken: options.agentToken,
      }
    : { ...readAgentRelayEnv(), ...options };
  const base = new URL(env.baseUrl!);
  if (
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/" ||
    !["https:", "http:"].includes(base.protocol)
  )
    throw new AgentRelayTransportError("Invalid Relay task base URL");
  const loopback =
    base.hostname === "[::1]" ||
    (isIP(base.hostname) === 4 && base.hostname.startsWith("127."));
  if (base.protocol !== "https:" && !loopback) {
    throw new AgentRelayTransportError(
      "Relay task credentials require HTTPS outside literal loopback addresses",
    );
  }
  const baseUrl = base.origin;
  const timeoutMs = request.timeoutMs ?? 86_400_000;
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 86_400_000 ||
    ![
      request.runId,
      request.stepId,
      request.idempotencyKey,
      request.dataDir,
      request.cli,
    ].every(nonempty)
  ) {
    throw new AgentRelayTransportError(
      "Relay task requires durable dispatch identity and a valid deadline",
    );
  }
  const pollMs = options.pollMs ?? 1000;
  if (!Number.isFinite(pollMs) || pollMs < 1)
    throw new AgentRelayTransportError("Invalid Relay task polling interval");
  const doFetch = options.fetch ?? globalThis.fetch;
  const outer = options.signal ?? new AbortController().signal;
  // No durable claim exists while caller identity is being resolved. Bound
  // that read independently of the task's (potentially day-long) deadline.
  let deadline = Date.now() + 30_000;
  let missingDeadline = Date.now() + 30_000;
  async function http(
    path: string,
    body?: unknown,
  ): Promise<Record<string, unknown>> {
    for (;;) {
      outer.throwIfAborted();
      if (Date.now() >= deadline)
        throw new AgentRelayTransportError(
          "Relay task status unavailable before its reconciliation deadline",
        );
      const bounded = AbortSignal.any([
        outer,
        AbortSignal.timeout(
          Math.min(15_000, Math.max(1, deadline - Date.now())),
        ),
      ]);
      let response: Response | undefined;
      let value: unknown;
      try {
        response = await doFetch(new URL(path, baseUrl), {
          method: body === undefined ? "GET" : "POST",
          redirect: "error",
          signal: bounded,
          headers: {
            authorization: `Bearer ${env.agentToken}`,
            "content-type": "application/json",
            ...(body === undefined
              ? {}
              : { "Idempotency-Key": request.idempotencyKey }),
          },
          ...(body === undefined ? {} : { body: canonicalize(body) }),
        });
        if (
          response.status === 404 &&
          body === undefined &&
          path.includes("/invocations/")
        ) {
          if (Date.now() >= missingDeadline)
            throw new AgentRelayTransportError(
              "Relay task dispatch remains unconfirmed; no repeat POST is permitted",
            );
        } else if (
          !response.ok &&
          response.status !== 429 &&
          response.status < 500
        ) {
          // Never copy untrusted response bodies, URLs, or tokens into diagnostics.
          throw new AgentRelayTransportError(
            `Relay task request refused with HTTP ${response.status}`,
          );
        }
        if (response.ok) value = await response.json();
        if (body !== undefined && !response.ok) return {}; // ambiguous POST: GET only below
      } catch (error) {
        outer.throwIfAborted();
        if (error instanceof AgentRelayTransportError) throw error;
        if (body !== undefined) return {}; // response loss or invalid JSON never causes another POST
        if (response?.ok && !bounded.aborted)
          throw new AgentRelayTransportError(
            "Relay task response was not valid JSON",
          );
      }
      outer.throwIfAborted();
      if (response?.ok && value !== undefined) {
        if (!isRecord(value) || value.ok !== true || !isRecord(value.data))
          throw new AgentRelayTransportError(
            "Relay task response has an invalid data envelope",
          );
        return value.data;
      }
      await delay(pollMs, undefined, { signal: outer });
    }
  }
  // Resolving the agent is read-only. Pin identity before any invocation so a
  // restarted runner cannot create a second task using another caller's key.
  const agent = await http("/v1/agent");
  if (!nonempty(agent.id))
    throw new AgentRelayTransportError("Relay task caller identity is missing");
  if (!nonempty(agent.workspace_id))
    throw new AgentRelayTransportError(
      "Relay task workspace identity is missing",
    );
  // Pinned action-invoke-v1 identity contract from Relaycast #436.
  const invocationId =
    "inv_idem_" +
    createHash("sha256")
      .update(
        [
          "action-invoke-v1",
          agent.workspace_id,
          agent.id,
          "task.run",
          request.idempotencyKey,
        ].join("\0"),
      )
      .digest("hex");
  const input = {
    cli: request.cli,
    task: request.task,
    ...(request.model === undefined ? {} : { model: request.model }),
    ...(request.worker_cwd === undefined
      ? {}
      : { worker_cwd: request.worker_cwd }),
    ...(request.result_schema === undefined
      ? {}
      : { result_schema: request.result_schema }),
    task_context: {
      run_id: request.runId,
      step_id: request.stepId,
      dispatch_id: request.idempotencyKey,
      timeout_ms: timeoutMs,
    },
  };
  const { claim, created } = await claimRelayTask(request.dataDir, {
    version: 1,
    baseUrl,
    callerId: agent.id,
    workspaceId: agent.workspace_id,
    invocationId,
    runId: request.runId,
    stepId: request.stepId,
    idempotencyKey: request.idempotencyKey,
    input,
    startedAt: Date.now(),
  });
  // A restarted runner may recover a terminal receipt after the task deadline.
  // Give that read one bounded window; never reopen or extend the remote task.
  deadline = Math.max(
    claim.startedAt + timeoutMs + 30_000,
    Date.now() + 15_000,
  );
  missingDeadline = claim.startedAt + 30_000;
  if (created) {
    const ack = await http("/v1/actions/task.run/invoke", { input });
    if (
      Object.keys(ack).length &&
      (ack.invocation_id !== invocationId ||
        ack.action_name !== "task.run" ||
        canonicalize(ack.input) !== canonicalize(input))
    ) {
      throw new AgentRelayTransportError(
        "Relay task acknowledgment has mismatched invocation or input",
      );
    }
    // A matching acknowledgment proves the POST committed. GET may still lag
    // briefly, but the durable claim forbids another POST, so reconcile until
    // the task deadline instead of applying the ambiguous-POST cutoff.
    if (Object.keys(ack).length) missingDeadline = deadline;
  }
  let previous: RelayTaskReceipt | undefined;
  for (;;) {
    const value = await http(
      `/v1/actions/task.run/invocations/${encodeURIComponent(invocationId)}`,
    );
    if (value.caller_id !== agent.id)
      throw new AgentRelayTransportError(
        "Relay task receipt belongs to another caller",
      );
    const receipt = readTaskReceipt(value, invocationId, input, previous);
    outer.throwIfAborted();
    if (receipt.status === "completed" || receipt.status === "failed")
      return receipt;
    previous = receipt;
    await delay(pollMs, undefined, { signal: outer });
  }
}
