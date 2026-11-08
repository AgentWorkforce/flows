import { createHash } from 'node:crypto';
import { claimNodeSpawn, recordNodeSpawn, type NodeSpawnClaim } from './node-spawn-state.js';
import { nodeResultInstruction, waitForNodeResult } from './node-spawn-result.js';
import { createRemoteNodeSpawnRuntime, type NodeSpawnRuntime } from './node-spawn-runtime.js';
import { NodeSpawnError, nonempty, validIdempotencyKey,
  type NodeSpawnIdentity, type NodeSpawnReceipt } from './node-spawn.js';
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
  constructor(
    message: string,
    public readonly cause?: unknown,
    /** Exact cleanup is durable and must be retried by a replacement attempt. */
    public readonly cleanupPending = false,
  ) {
    super(message);
    this.name = 'AgentRelayTransportError';
  }
}

const RESULT_RECOVERY_WINDOW_MS = 30_000;

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
  const taskStartedAt = Date.now();
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
  }, { signal: options.signal });
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
    startedAt: taskStartedAt,
  };
  const claimed = await claimNodeSpawn(request.dataDir, proposed);
  let claim = claimed.claim;
  let releaseAttempted = false;
  const deadline = claim.startedAt + timeoutMs;
  try {
    if (!claimed.created && claim.spawn === undefined) {
      if (claim.cleanup === undefined) {
        throw new AgentRelayTransportError(
          'A prior node-spawn dispatch ended in the ambiguous pre-ack window; refusing a second spawn');
      }
      if (claim.release === undefined) {
        releaseAttempted = true;
        const cleanup = await tryRelease(runtime, claimed.path, claim, request.idempotencyKey);
        claim = cleanup.claim;
        if (cleanup.error !== undefined) throw cleanup.error;
      }
      throw new NodeSpawnError(claim.failure?.message ?? 'The prior node spawn failed after launch',
        claim.failure?.code ?? 'spawn_unconfirmed');
    }
    assertWithinDeadline(claim.result === undefined ? deadline : deadline + RESULT_RECOVERY_WINDOW_MS);
    options.signal?.throwIfAborted();
    if (claim.spawn === undefined) {
      // This is deliberately adjacent to the irreversible dispatch. Runtime
      // setup and durable claiming can take time or lose the worker lease.
      options.signal?.throwIfAborted();
      const remaining = remainingDeadline(deadline);
      const pendingSpawn = runtime.port.spawn({
        name: agentName,
        harness: request.cli,
        task,
        ...(request.model === undefined ? {} : { model: request.model }),
        ...(request.worker_cwd === undefined ? {} : { directory: request.worker_cwd }),
        idempotencyKey: request.idempotencyKey,
        ...(runtime.node === undefined ? {} : { node: runtime.node }),
        ...(runtime.repo === undefined ? {} : { repo: runtime.repo }),
        ...(runtime.sandboxOnly === undefined ? {} : { sandboxOnly: runtime.sandboxOnly }),
        timeoutMs: remaining,
      });
      const spawnTimeout = AbortSignal.timeout(remaining);
      const spawnSignal = options.signal === undefined
        ? spawnTimeout : AbortSignal.any([options.signal, spawnTimeout]);
      const spawn = await waitForSpawn(pendingSpawn, spawnSignal, outcome => {
        void settleLateSpawn(outcome).catch(() => undefined);
      });
      claim = { ...claim, spawn };
      await recordNodeSpawn(claimed.path, claim);
      options.signal?.throwIfAborted();
    } else {
      if (claim.cleanupPending !== undefined && claim.result === undefined
        && claim.release === undefined) {
        releaseAttempted = true;
        const cleanup = await tryRelease(runtime, claimed.path, claim, request.idempotencyKey);
        claim = cleanup.claim;
        if (cleanup.error !== undefined) throw cleanup.error;
        throw new NodeSpawnError(
          claim.failure?.message ?? 'The prior node spawn failed after launch',
          claim.failure?.code ?? 'spawn_unconfirmed',
        );
      }
      if (claim.release !== undefined && claim.result === undefined) {
        throw new NodeSpawnError(
          claim.failure?.message ?? 'The recorded node spawn was released before it reported a result',
          claim.failure?.code ?? 'spawn_released',
        );
      }
      const status = await runtime.port.status('spawn', claim.spawn.id);
      if (status.status !== 'completed') {
        throw new NodeSpawnError('The recorded node spawn is no longer completed',
          status.errorCode ?? `spawn_${status.status}`);
      }
    }
    const spawn = claim.spawn;
    if (spawn === undefined) throw new AgentRelayTransportError('Node-spawn claim lost its confirmed receipt');
    if (claim.result !== undefined && claim.release === undefined) {
      releaseAttempted = true;
      const cleanup = await tryRelease(runtime, claimed.path, claim, request.idempotencyKey);
      claim = cleanup.claim;
      if (cleanup.error !== undefined) throw cleanup.error;
    }
    const waitDeadline = claim.result === undefined ? deadline : deadline + RESULT_RECOVERY_WINDOW_MS;
    assertWithinDeadline(waitDeadline);
    const timeout = AbortSignal.timeout(remainingDeadline(waitDeadline));
    const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
    const delivery = await waitForNodeResult(runtime.inbox, {
      agentId: spawn.agentId,
      agentName: spawn.name,
      ...correlation,
    }, signal);
    signal.throwIfAborted();
    if (claim.result !== undefined
      && (claim.result.inboxItemId !== delivery.inboxItemId || claim.result.messageId !== delivery.messageId)) {
      throw new NodeSpawnError('The redelivered result did not match the durable delivery identity',
        'result_identity_mismatch');
    }
    if (claim.result === undefined) {
      claim = { ...claim, result: { inboxItemId: delivery.inboxItemId,
        messageId: delivery.messageId, status: delivery.envelope.status, receivedAt: Date.now() } };
      await recordNodeSpawn(claimed.path, claim);
    }
    if (claim.release === undefined) {
      releaseAttempted = true;
      const cleanup = await tryRelease(runtime, claimed.path, claim, request.idempotencyKey);
      claim = cleanup.claim;
      if (cleanup.error !== undefined) throw cleanup.error;
    }
    signal.throwIfAborted();
    const envelope = delivery.envelope;
    const error = envelope.status === 'failed' ? envelope.error! : null;
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
    let cleanupError: unknown;
    if ((claim.spawn !== undefined || claim.cleanup !== undefined)
      && claim.release === undefined && claim.failure === undefined) {
      claim = { ...claim, failure: failureRecord(error, options.signal) };
      try { await recordNodeSpawn(claimed.path, claim); }
      catch (stateError) { cleanupError = stateError; }
    }
    if (error instanceof NodeSpawnError && error.cleanup !== undefined && claim.spawn === undefined) {
      claim = { ...claim, cleanup: error.cleanup,
        failure: { code: error.code, message: error.message } };
      try { await recordNodeSpawn(claimed.path, claim); }
      catch (stateError) { cleanupError = stateError; }
    }
    if ((claim.spawn !== undefined || claim.cleanup !== undefined)
      && claim.release === undefined && !releaseAttempted) {
      releaseAttempted = true;
      const cleanup = await tryRelease(runtime, claimed.path, claim, request.idempotencyKey);
      claim = cleanup.claim;
      cleanupError ??= cleanup.error;
    }
    options.signal?.throwIfAborted();
    const detail = cleanupError === undefined
      ? safeError(error)
      : `${safeError(error)}; exact cleanup remains pending: ${safeError(cleanupError)}`;
    const exactCleanupPending = claim.release === undefined
      && claim.cleanupPending !== undefined
      && (claim.spawn !== undefined || claim.cleanup !== undefined);
    throw new AgentRelayTransportError(detail, error, exactCleanupPending);
  }

  async function settleLateSpawn(outcome: { spawn?: NodeSpawnReceipt; error?: unknown }): Promise<void> {
    if (outcome.spawn !== undefined) {
      claim = { ...claim, spawn: outcome.spawn, failure: {
        code: 'spawn_cancelled',
        message: 'The node spawn confirmed after its caller stopped waiting',
      } };
    } else if (outcome.error instanceof NodeSpawnError && outcome.error.cleanup !== undefined) {
      claim = { ...claim, cleanup: outcome.error.cleanup,
        failure: { code: outcome.error.code, message: outcome.error.message } };
    } else {
      return;
    }
    try { await recordNodeSpawn(claimed.path, claim); }
    catch { /* Exact in-memory identity is still sufficient for this cleanup attempt. */ }
    const cleanup = await tryRelease(runtime, claimed.path, claim, request.idempotencyKey);
    claim = cleanup.claim;
  }
}

async function waitForSpawn(
  pending: Promise<NodeSpawnReceipt>,
  signal: AbortSignal,
  onLate: (outcome: { spawn?: NodeSpawnReceipt; error?: unknown }) => void,
): Promise<NodeSpawnReceipt> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([pending, aborted]); }
  catch (error) {
    if (signal.aborted) {
      void pending.then(spawn => onLate({ spawn }), lateError => onLate({ error: lateError }));
    }
    throw error;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

async function tryRelease(
  runtime: NodeSpawnRuntime,
  path: string,
  claim: NodeSpawnClaim,
  idempotencyKey: string,
): Promise<{ claim: NodeSpawnClaim; error?: unknown }> {
  const receipt: NodeSpawnIdentity | undefined = claim.spawn ?? claim.cleanup;
  if (receipt === undefined || claim.release !== undefined) return { claim };
  try {
    const released = await runtime.port.release({ receipt,
      idempotencyKey: releaseKey(idempotencyKey) });
    const { cleanupPending: _cleanupPending, ...withoutPending } = claim;
    const updated: NodeSpawnClaim = { ...withoutPending,
      release: { invocationId: released.id, status: released.status } };
    await recordNodeSpawn(path, updated);
    return { claim: updated };
  } catch (error) {
    const updated: NodeSpawnClaim = { ...claim, cleanupPending: {
      attempts: (claim.cleanupPending?.attempts ?? 0) + 1,
      lastError: safeError(error),
      updatedAt: Date.now(),
    } };
    try { await recordNodeSpawn(path, updated); }
    catch (stateError) {
      return { claim: updated,
        error: new AgentRelayTransportError(`${safeError(error)}; cleanup state was not durable: ${safeError(stateError)}`, error) };
    }
    return { claim: updated, error };
  }
}

function remainingDeadline(deadline: number): number {
  const remaining = deadline - Date.now();
  if (!Number.isSafeInteger(remaining) || remaining < 1) {
    throw new NodeSpawnError('The node-spawn task deadline elapsed', 'task_timeout');
  }
  return remaining;
}

function assertWithinDeadline(deadline: number): void {
  remainingDeadline(deadline);
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

function failureRecord(error: unknown, signal?: AbortSignal): { code: string; message: string } {
  return {
    code: error instanceof NodeSpawnError
      ? error.code
      : signal?.aborted === true ? 'task_cancelled' : 'node_spawn_failed',
    message: safeError(error),
  };
}
