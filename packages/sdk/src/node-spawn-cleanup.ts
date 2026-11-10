import { createHash } from 'node:crypto';
import { recordNodeSpawn, type NodeSpawnClaim } from './node-spawn-state.js';
import type { NodeSpawnRuntime } from './node-spawn-runtime.js';
import { NodeSpawnError, nonempty, type NodeSpawnIdentity } from './node-spawn.js';

const CLEANUP_ATTEMPT_TIMEOUT_MS = 15_000;

/** True only when durable terminal evidence makes exact release recoverable. */
export function nodeSpawnCleanupRequired(claim: NodeSpawnClaim): boolean {
  return claim.release === undefined
    && (claim.spawn !== undefined || claim.cleanup !== undefined)
    && (claim.cleanupPending !== undefined || claim.failure !== undefined || claim.result !== undefined);
}

/** Attempts the claim's exact, idempotent release and persists either outcome. */
export async function releaseNodeSpawnClaim(
  runtime: Pick<NodeSpawnRuntime, 'port'>,
  path: string,
  claim: NodeSpawnClaim,
): Promise<{ claim: NodeSpawnClaim; error?: unknown }> {
  const receipt: NodeSpawnIdentity | undefined = claim.spawn ?? claim.cleanup;
  if (receipt === undefined || claim.release !== undefined) return { claim };
  try {
    const released = await boundedCleanup(runtime.port.release({
      receipt,
      idempotencyKey: releaseKey(claim.idempotencyKey),
    }));
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
        error: new NodeSpawnError(
          `${safeError(error)}; cleanup state was not durable: ${safeError(stateError)}`,
          'release_unconfirmed', error) };
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
  // so it cannot become an unhandled rejection; reconciliation reuses the
  // same idempotency key for the exact release.
  const outcome = pending.then(value => ({ ok: true as const, value }),
    error => ({ ok: false as const, error }));
  try {
    const settled = await Promise.race([outcome, deadline]);
    if (!settled.ok) throw settled.error;
    return settled.value;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function releaseKey(key: string): string {
  return `release_${createHash('sha256').update(key).digest('hex').slice(0, 32)}`;
}

function safeError(error: unknown): string {
  return error instanceof Error && error.message ? error.message : 'Node-spawn task failed';
}
