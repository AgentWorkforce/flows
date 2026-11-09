import { createHash } from 'node:crypto';
import { claimNodeSpawnAtPath, nodeSpawnClaimPath, recordNodeSpawn,
  type NodeSpawnClaim } from './node-spawn-state.js';
import { nodeResultInstruction, waitForNodeResult } from './node-spawn-result.js';
import { durableNodeResultDelivery } from './node-spawn-settlement.js';
import { waitForNodeOperation, waitForNodeSpawn } from './node-spawn-deadline.js';
import { createNodeSpawnRuntime, type NodeSpawnRuntime } from './node-spawn-runtime.js';
import { NodeSpawnError, nonempty, validIdempotencyKey,
  validNodeSpawnIdentity, validNodeSpawnReceipt,
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
  attempt: number;
  dataDir: string;
  /** Engine task contract ceiling; bounded independently of the worker lease. */
  timeoutMs?: number;
}
export interface AgentRelayEnv {
  baseUrl?: string;
  agentToken?: string;
  /** Absolute Desktop schema-v2 caller.json path; mutually exclusive with agentToken. */
  serviceCallerFile?: string;
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

const CLEANUP_ATTEMPT_TIMEOUT_MS = 15_000;
const claimExecutions = new Map<string, Promise<void>>();

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
  options: AgentRelayEnv & { runtime?: NodeSpawnRuntime;
    runtimeProvider?: (signal?: AbortSignal) => Promise<NodeSpawnRuntime>; signal?: AbortSignal } = {},
): Promise<RelayTaskResult> {
  const taskStartedAt = Date.now();
  options.signal?.throwIfAborted();
  const timeoutMs = request.timeoutMs ?? 86_400_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 86_400_000
    || !Number.isSafeInteger(request.attempt) || request.attempt < 1
    || ![request.runId, request.stepId, request.dataDir, request.cli].every(nonempty)
    || !validIdempotencyKey(request.idempotencyKey)) {
    throw new AgentRelayTransportError('Node-spawn task requires durable dispatch identity and a valid deadline');
  }
  const claimPath = await nodeSpawnClaimPath(
    request.dataDir, request.runId, request.stepId, request.idempotencyKey);
  const taskDeadline = taskStartedAt + timeoutMs;
  return serializeClaimExecution(claimPath, taskDeadline, options.signal, async () => {
    options.signal?.throwIfAborted();
    return runAgentRelayTaskExclusive(request, claimPath, options, taskStartedAt, timeoutMs);
  });
}

async function runAgentRelayTaskExclusive(
  request: AgentRelayTaskRequest,
  claimPath: string,
  options: AgentRelayEnv & { runtime?: NodeSpawnRuntime;
    runtimeProvider?: (signal?: AbortSignal) => Promise<NodeSpawnRuntime>; signal?: AbortSignal },
  taskStartedAt: number,
  timeoutMs: number,
): Promise<RelayTaskResult> {
  const taskDeadline = taskStartedAt + timeoutMs;
  let acquisitionRemaining: number;
  try { acquisitionRemaining = remainingDeadline(taskDeadline); }
  catch (error) {
    throw new AgentRelayTransportError('The node-spawn task deadline elapsed', error);
  }
  const ownsRuntime = options.runtime === undefined && options.runtimeProvider === undefined;
  const acquisitionTimeout = AbortSignal.timeout(acquisitionRemaining);
  const acquisitionSignal = options.signal === undefined
    ? acquisitionTimeout : AbortSignal.any([options.signal, acquisitionTimeout]);
  let runtime: NodeSpawnRuntime;
  try {
    if (options.runtime !== undefined) {
      runtime = options.runtime;
    } else if (options.runtimeProvider !== undefined) {
      runtime = await waitForNodeOperation(options.runtimeProvider(acquisitionSignal), acquisitionSignal);
    } else {
      runtime = await createNodeSpawnRuntime({
        ...process.env,
        ...(options.baseUrl === undefined ? {} : { RELAY_BASE_URL: options.baseUrl }),
        ...(options.agentToken === undefined ? {} : { RELAY_AGENT_TOKEN: options.agentToken }),
        ...(options.serviceCallerFile === undefined
          ? {}
          : { RELAYFLOW_SERVICE_CALLER_FILE: options.serviceCallerFile }),
        ...(options.node === undefined ? {} : { RELAYFLOW_NODE_NAME: options.node }),
        ...(options.repo === undefined ? {} : { RELAYFLOW_NODE_REPO: options.repo }),
        ...(options.sandboxOnly === undefined
          ? {} : { RELAYFLOW_NODE_SANDBOX_ONLY: options.sandboxOnly ? '1' : '0' }),
      }, { signal: acquisitionSignal });
    }
  } catch (error) {
    if (options.signal?.aborted !== true && acquisitionTimeout.aborted) {
      const timeout = new NodeSpawnError('The node-spawn task deadline elapsed', 'task_timeout', error);
      throw new AgentRelayTransportError(timeout.message, timeout);
    }
    throw error;
  }
  try {
    return await executeAgentRelayTask(
      request, claimPath, runtime, options.signal, taskStartedAt, timeoutMs);
  } finally {
    if (ownsRuntime) await runtime.disconnect?.().catch(() => undefined);
  }
}

async function serializeClaimExecution<T>(
  path: string,
  deadline: number,
  signal: AbortSignal | undefined,
  execute: () => Promise<T>,
): Promise<T> {
  const prior = claimExecutions.get(path) ?? Promise.resolve();
  let release!: () => void;
  const occupied = new Promise<void>(resolve => { release = resolve; });
  const queued = prior.then(() => occupied, () => occupied);
  claimExecutions.set(path, queued);
  let acquired = false;
  try {
    let remaining: number;
    try { remaining = remainingDeadline(deadline); }
    catch (error) {
      throw new AgentRelayTransportError('The node-spawn task deadline elapsed', error);
    }
    const queueTimeout = AbortSignal.timeout(remaining);
    const queueSignal = signal === undefined ? queueTimeout : AbortSignal.any([signal, queueTimeout]);
    try { await waitForNodeOperation(prior, queueSignal); }
    catch (error) {
      if (signal?.aborted !== true && queueTimeout.aborted) {
        const timeout = new NodeSpawnError('The node-spawn task deadline elapsed', 'task_timeout', error);
        throw new AgentRelayTransportError(timeout.message, timeout);
      }
      throw error;
    }
    acquired = true;
    return await execute();
  } finally {
    release();
    if (acquired && claimExecutions.get(path) === queued) {
      claimExecutions.delete(path);
    } else if (!acquired) {
      void queued.then(() => {
        if (claimExecutions.get(path) === queued) claimExecutions.delete(path);
      });
    }
  }
}

async function executeAgentRelayTask(
  request: AgentRelayTaskRequest,
  claimPath: string,
  runtime: NodeSpawnRuntime,
  signal: AbortSignal | undefined,
  taskStartedAt: number,
  timeoutMs: number,
): Promise<RelayTaskResult> {
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
    timeoutMs,
    request: {
      cli: request.cli, task, ...(request.model === undefined ? {} : { model: request.model }),
      ...(request.worker_cwd === undefined ? {} : { worker_cwd: request.worker_cwd }),
      ...(runtime.node === undefined ? {} : { node: runtime.node }),
      ...(runtime.repo === undefined ? {} : { repo: runtime.repo }),
      ...(runtime.sandboxOnly === undefined ? {} : { sandbox_only: runtime.sandboxOnly }),
    },
    startedAt: taskStartedAt,
  };
  const claimed = await claimNodeSpawnAtPath(claimPath, proposed);
  let claim = claimed.claim;
  let releaseAttempted = false;
  const deadline = claim.startedAt + claim.timeoutMs;
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
    if (claim.result === undefined) assertWithinDeadline(deadline);
    signal?.throwIfAborted();
    if (claim.spawn === undefined) {
      // This is deliberately adjacent to the irreversible dispatch. Runtime
      // setup and durable claiming can take time or lose the worker lease.
      signal?.throwIfAborted();
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
      const spawnSignal = signal === undefined
        ? spawnTimeout : AbortSignal.any([signal, spawnTimeout]);
      const spawn = await waitForNodeSpawn(pendingSpawn, spawnSignal, outcome => {
        void settleLateSpawn(outcome).catch(() => undefined);
      });
      if (!validNodeSpawnReceipt(spawn) || spawn.name !== agentName) {
        throw new NodeSpawnError('The node spawn did not return a valid ready identity',
          'spawn_identity_mismatch', undefined,
          validNodeSpawnIdentity(spawn) ? spawn : undefined);
      }
      claim = { ...claim, spawn };
      await recordNodeSpawn(claimed.path, claim);
      signal?.throwIfAborted();
    } else {
      // A durable result is the authoritative completion record. Requiring a
      // live placement lookup here would make crash recovery depend on a
      // remote invocation record that may expire after exact cleanup.
      if (claim.result === undefined) {
        if ((claim.cleanupPending !== undefined || claim.failure !== undefined)
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
        if (claim.release !== undefined) {
          throw new NodeSpawnError(
            claim.failure?.message ?? 'The recorded node spawn was released before it reported a result',
            claim.failure?.code ?? 'spawn_released',
          );
        }
        const remaining = remainingDeadline(deadline);
        const statusTimeout = AbortSignal.timeout(remaining);
        const statusSignal = signal === undefined
          ? statusTimeout : AbortSignal.any([signal, statusTimeout]);
        const status = await waitForNodeOperation(runtime.port.status('spawn', claim.spawn.id), statusSignal);
        if (status.status !== 'completed') {
          throw new NodeSpawnError('The recorded node spawn is no longer completed',
            status.errorCode ?? `spawn_${status.status}`);
        }
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
    const resultSignal = claim.result === undefined
      ? (signal === undefined
          ? AbortSignal.timeout(remainingDeadline(deadline))
          : AbortSignal.any([signal, AbortSignal.timeout(remainingDeadline(deadline))]))
      : signal;
    const observed = claim.result === undefined
      ? await waitForNodeResult(runtime.inbox, {
          agentId: spawn.agentId,
          agentName: spawn.name,
          invocationId: spawn.id,
          ...correlation,
        }, resultSignal)
      : undefined;
    resultSignal?.throwIfAborted();
    if (claim.result !== undefined
      && observed !== undefined
      && (claim.result.inboxItemId !== observed.inboxItemId || claim.result.messageId !== observed.messageId)) {
      throw new NodeSpawnError('The redelivered result did not match the durable delivery identity',
        'result_identity_mismatch');
    }
    if (claim.result === undefined) {
      if (observed === undefined) throw new NodeSpawnError('Node result disappeared before it became durable');
      claim = { ...claim, result: { inboxItemId: observed.inboxItemId,
        messageId: observed.messageId, status: observed.envelope.status,
        envelope: observed.envelope, settlementAction: observed.settlementAction,
        receivedAt: Date.now() } };
      await recordNodeSpawn(claimed.path, claim);
    }
    if (claim.release === undefined) {
      releaseAttempted = true;
      const cleanup = await tryRelease(runtime, claimed.path, claim, request.idempotencyKey);
      claim = cleanup.claim;
      if (cleanup.error !== undefined) throw cleanup.error;
    }
    // Construct the settlement wrapper from the post-release claim. Otherwise
    // preparing its journal intent could rewrite the file from a stale copy
    // and silently discard the exact release receipt.
    const delivery = durableNodeResultDelivery(runtime, claimed.path, claim, observed);
    resultSignal?.throwIfAborted();
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
          deadline: new Date(deadline).toISOString(),
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
      claim = { ...claim, failure: failureRecord(error, signal) };
      try { await recordNodeSpawn(claimed.path, claim); }
      catch (stateError) { cleanupError = stateError; }
    }
    if (error instanceof NodeSpawnError && validNodeSpawnIdentity(error.cleanup)
      && claim.spawn === undefined) {
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
    signal?.throwIfAborted();
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
      const identity = validNodeSpawnIdentity(outcome.spawn) ? outcome.spawn : undefined;
      if (identity === undefined) return;
      claim = { ...claim,
        ...(validNodeSpawnReceipt(outcome.spawn) && outcome.spawn.name === agentName
          ? { spawn: outcome.spawn } : { cleanup: identity }),
        failure: {
        code: 'spawn_cancelled',
        message: 'The node spawn confirmed after its caller stopped waiting',
      } };
    } else if (outcome.error instanceof NodeSpawnError
      && validNodeSpawnIdentity(outcome.error.cleanup)) {
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

async function tryRelease(
  runtime: NodeSpawnRuntime,
  path: string,
  claim: NodeSpawnClaim,
  idempotencyKey: string,
): Promise<{ claim: NodeSpawnClaim; error?: unknown }> {
  const receipt: NodeSpawnIdentity | undefined = claim.spawn ?? claim.cleanup;
  if (receipt === undefined || claim.release !== undefined) return { claim };
  try {
    const released = await boundedCleanup(runtime.port.release({ receipt,
      idempotencyKey: releaseKey(idempotencyKey) }));
    if (released.action !== 'release' || released.status !== 'completed'
      || released.released !== true || !nonempty(released.id)) {
      throw new NodeSpawnError('The node did not confirm exact agent release',
        released.errorCode ?? 'release_unconfirmed');
    }
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

async function boundedCleanup<T>(pending: Promise<T>): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new NodeSpawnError(
      'Exact node cleanup did not confirm within its independent deadline', 'release_unconfirmed')),
    CLEANUP_ATTEMPT_TIMEOUT_MS);
  });
  // A transport that ignores cancellation may settle after this attempt has
  // durably recorded cleanupPending. Fold that late outcome into this promise
  // so it cannot become an unhandled rejection; the next attempt reuses the
  // same idempotency key and reconciles the exact release.
  const outcome = pending.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  try {
    const settled = await Promise.race([outcome, deadline]);
    if (!settled.ok) throw settled.error;
    return settled.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
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
