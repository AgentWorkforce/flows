import { waitForNodeSpawn } from './node-spawn-deadline.js';
import { claimNodeSpawnDispatch, hasNodeSpawnDispatchFence,
  type NodeSpawnClaim } from './node-spawn-state.js';
import { NodeSpawnError, NodeSpawnPreDispatchError,
  validNodeSpawnIdentity, validNodeSpawnReceipt,
  type NodeSpawnPort, type NodeSpawnReceipt, type NodeSpawnRequest } from './node-spawn.js';

interface FencedNodeSpawnOptions {
  port: NodeSpawnPort;
  request: NodeSpawnRequest & { timeoutMs: number };
  claimPath: string;
  claim: NodeSpawnClaim;
  signal?: AbortSignal;
  settleLate(outcome: { spawn?: NodeSpawnReceipt; error?: unknown }): Promise<void>;
}

/** Enters exactly one irreversible spawn behind a durable, one-way fence. */
export async function dispatchFencedNodeSpawn(
  options: FencedNodeSpawnOptions,
): Promise<NodeSpawnReceipt> {
  let dispatchPublished = false;
  let dispatchHookEntered = false;
  let pendingSpawn: Promise<NodeSpawnReceipt>;
  try {
    pendingSpawn = options.port.spawn(options.request, async () => {
      dispatchHookEntered = true;
      options.signal?.throwIfAborted();
      await claimNodeSpawnDispatch(options.claimPath, options.claim);
      dispatchPublished = true;
    });
  } catch (error) {
    pendingSpawn = Promise.reject(error);
  }
  const spawnTimeout = AbortSignal.timeout(options.request.timeoutMs);
  const spawnSignal = options.signal === undefined
    ? spawnTimeout : AbortSignal.any([options.signal, spawnTimeout]);
  let spawn: NodeSpawnReceipt;
  try {
    spawn = await waitForNodeSpawn(pendingSpawn, spawnSignal, outcome => {
      void options.settleLate(outcome).catch(() => undefined);
    });
  } catch (error) {
    if (!dispatchPublished && dispatchHookEntered) {
      // Publication may fail before the atomic link (safe to retry) or after
      // it (permanently ambiguous). Observe once without creating a fence.
      dispatchPublished = await hasNodeSpawnDispatchFence(options.claimPath, options.claim);
    } else if (!dispatchPublished && !(error instanceof NodeSpawnPreDispatchError)) {
      // An untrusted port did not prove that it stopped before dispatch.
      await claimNodeSpawnDispatch(options.claimPath, options.claim);
      dispatchPublished = true;
    }
    throw error;
  }
  if (!dispatchPublished) {
    await claimNodeSpawnDispatch(options.claimPath, options.claim);
    dispatchPublished = true;
    throw new NodeSpawnError(
      'The node-spawn port returned without publishing its required dispatch fence',
      'spawn_dispatch_fence_missing',
      undefined,
      validNodeSpawnIdentity(spawn) ? spawn : undefined,
    );
  }
  if (!await hasNodeSpawnDispatchFence(options.claimPath, options.claim)) {
    throw new NodeSpawnError(
      'The node-spawn port did not leave its required dispatch fence durable',
      'spawn_dispatch_fence_missing',
      undefined,
      validNodeSpawnIdentity(spawn) ? spawn : undefined,
    );
  }
  if (!validNodeSpawnReceipt(spawn) || spawn.name !== options.request.name) {
    throw new NodeSpawnError('The node spawn did not return a valid ready identity',
      'spawn_identity_mismatch', undefined,
      validNodeSpawnIdentity(spawn) ? spawn : undefined);
  }
  return spawn;
}
