import { createHash } from 'node:crypto';
import { claimNodeSpawn, recordNodeSpawn, type NodeSpawnClaim } from './node-spawn-state.js';
import { nodeResultInstruction, waitForNodeResult } from './node-spawn-result.js';
import { createRemoteNodeSpawnRuntime, type NodeSpawnRuntime } from './node-spawn-runtime.js';
import { NodeSpawnError, nonempty, validIdempotencyKey } from './node-spawn.js';
import type { RelayTaskResult } from './agent-relay-receipt.js';

export type AgentTransport = 'direct' | 'relay';
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
  /** Engine task contract ceiling; bounded independently of the worker lease. */
  timeoutMs?: number;
}
export interface AgentRelayEnv {
  baseUrl?: string;
  agentToken?: string;
  node?: string;
  repo?: string;
  sandboxOnly?: boolean;
}
export class AgentRelayTransportError extends Error {
  constructor(message: string, public readonly cause?: unknown) {
    super(message);
    this.name = 'AgentRelayTransportError';
  }
}

export function readAgentRelayEnv(env: NodeJS.ProcessEnv = process.env): Required<Pick<AgentRelayEnv, 'baseUrl' | 'agentToken'>> {
  const agentToken = env.RELAY_AGENT_TOKEN?.trim();
  if (!agentToken) throw new AgentRelayTransportError(
    'Node-spawn transport requires a dedicated publisher RELAY_AGENT_TOKEN.');
  return { baseUrl: env.RELAY_BASE_URL?.trim() || 'https://cast.agentrelay.com', agentToken };
}

/**
 * Dispatches exactly once through an Agent Relay node and waits on the
 * publisher's durable inbox. AgentWorker acks the returned delivery only
 * after stepComplete has durably entered the journal.
 */
export async function runAgentRelayTask(
  request: AgentRelayTaskRequest,
  options: AgentRelayEnv & { runtime?: NodeSpawnRuntime; signal?: AbortSignal } = {},
): Promise<RelayTaskResult> {
  options.signal?.throwIfAborted();
  const timeoutMs = request.timeoutMs ?? 86_400_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000
    || ![request.runId, request.stepId, request.dataDir, request.cli].every(nonempty)
    || !validIdempotencyKey(request.idempotencyKey)) {
    throw new AgentRelayTransportError('Node-spawn task requires durable dispatch identity and a valid deadline');
  }
  const runtime = options.runtime ?? await createRemoteNodeSpawnRuntime({
    ...process.env,
    ...(options.baseUrl === undefined ? {} : { RELAY_BASE_URL: options.baseUrl }),
    ...(options.agentToken === undefined ? {} : { RELAY_AGENT_TOKEN: options.agentToken }),
    ...(options.node === undefined ? {} : { RELAYFLOW_NODE_NAME: options.node }),
    ...(options.repo === undefined ? {} : { RELAYFLOW_NODE_REPO: options.repo }),
    ...(options.sandboxOnly === undefined ? {} : { RELAYFLOW_NODE_SANDBOX_ONLY: options.sandboxOnly ? '1' : '0' }),
  });
  const correlation = { runId: request.runId, stepId: request.stepId, dispatchId: request.idempotencyKey };
  const agentName = stableAgentName(request);
  const task = [
    request.task,
    request.result_schema === undefined ? undefined
      : `The final output must satisfy this JSON Schema: ${JSON.stringify(request.result_schema)}`,
    nodeResultInstruction(correlation),
  ].filter(nonempty).join('\n\n');
  const proposed: NodeSpawnClaim = {
    version: 2,
    baseUrl: runtime.baseUrl,
    publisherId: runtime.publisher.id,
    publisherName: runtime.publisher.name,
    runId: request.runId,
    stepId: request.stepId,
    idempotencyKey: request.idempotencyKey,
    agentName,
    request: {
      cli: request.cli, task, ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.worker_cwd === undefined ? {} : { worker_cwd: request.worker_cwd }),
      ...(runtime.node === undefined ? {} : { node: runtime.node }),
      ...(runtime.repo === undefined ? {} : { repo: runtime.repo }),
      ...(runtime.sandboxOnly === undefined ? {} : { sandbox_only: runtime.sandboxOnly }),
    },
    startedAt: Date.now(),
  };
  const claimed = await claimNodeSpawn(request.dataDir, proposed);
  let claim = claimed.claim;
  if (!claimed.created && claim.spawn === undefined) {
    throw new AgentRelayTransportError(
      'A prior node-spawn dispatch ended in the ambiguous pre-ack window; refusing a second spawn');
  }
  try {
    if (claim.spawn === undefined) {
      const spawn = await runtime.port.spawn({
        name: agentName,
        harness: request.cli,
        task,
        model: request.model,
        directory: request.worker_cwd,
        idempotencyKey: request.idempotencyKey,
        node: runtime.node,
        repo: runtime.repo,
        sandboxOnly: runtime.sandboxOnly,
        timeoutMs: Math.min(timeoutMs + 30_000, 86_430_000),
      });
      claim = { ...claim, spawn };
      await recordNodeSpawn(claimed.path, claim);
    } else {
      const status = await runtime.port.status('spawn', claim.spawn.id);
      if (status.status === 'failed') throw new NodeSpawnError('The recorded node spawn failed', status.errorCode);
    }
    const spawn = claim.spawn;
    if (spawn === undefined) throw new AgentRelayTransportError('Node-spawn claim lost its confirmed receipt');
    const timeout = AbortSignal.timeout(timeoutMs);
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
    const delivery = await waitForNodeResult(runtime.inbox, {
      agentId: spawn.agentId,
      agentName: spawn.name,
      ...correlation,
    }, signal);
    signal.throwIfAborted();
    let releaseError: unknown;
    if (claim.release === undefined) {
      try {
        const released = await runtime.port.release({ receipt: spawn,
          idempotencyKey: releaseKey(request.idempotencyKey) });
        claim = { ...claim, release: { invocationId: released.id, status: released.status } };
        await recordNodeSpawn(claimed.path, claim);
      } catch (error) { releaseError = error; }
    }
    signal.throwIfAborted();
    const envelope = delivery.envelope;
    const error = releaseError === undefined
      ? envelope.status === 'failed' ? envelope.error! : null
      : `Spawned agent release was not confirmed: ${safeError(releaseError)}`;
    const status = error === null ? 'completed' : 'failed';
    return {
      spawn,
      delivery,
      envelope,
      receipt: {
        invocation_id: spawn.id,
        action_name: 'spawn',
        status,
        task_execution: {
          execution_id: spawn.id,
          run_id: request.runId,
          step_id: request.stepId,
          dispatch_id: request.idempotencyKey,
          deadline: new Date(claim.startedAt + timeoutMs).toISOString(),
          node_id: spawn.nodeId,
          node_name: spawn.nodeName,
          agent_id: spawn.agentId,
          agent_name: spawn.name,
          delivery_id: delivery.inboxItemId,
          message_id: delivery.messageId,
          ...(claim.release === undefined ? {} : { release_invocation_id: claim.release.invocationId }),
          ...(envelope.accounting === undefined ? {} : { accounting: envelope.accounting }),
        },
        output: envelope.output,
        error,
        completed_at: new Date().toISOString(),
      },
    };
  } catch (error) {
    if (claim.spawn !== undefined && claim.release === undefined) {
      try {
        const released = await runtime.port.release({ receipt: claim.spawn,
          idempotencyKey: releaseKey(request.idempotencyKey) });
        claim = { ...claim, release: { invocationId: released.id, status: released.status } };
        await recordNodeSpawn(claimed.path, claim);
      } catch { /* Durable claim retains exact cleanup identity for audit/recovery. */ }
    }
    options.signal?.throwIfAborted();
    throw new AgentRelayTransportError(safeError(error), error);
  }
}

function stableAgentName(request: AgentRelayTaskRequest): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([request.runId, request.stepId, request.idempotencyKey]))
    .digest('hex').slice(0, 24);
  const label = request.stepId.toLowerCase().replace(/[^a-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '') || 'step';
  return `rf-${label.slice(0, 30)}-${digest}`;
}

function releaseKey(key: string): string {
  return `release_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

function safeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Node-spawn task failed';
}
