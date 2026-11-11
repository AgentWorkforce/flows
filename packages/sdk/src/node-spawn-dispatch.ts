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
  replayExistingFence?: boolean;
}

interface ExactPortIdentity {
  prototype: object;
  spawn: NodeSpawnPort['spawn'];
  targets: NodeSpawnPort['targets'];
  status: NodeSpawnPort['status'];
  release: NodeSpawnPort['release'];
}

interface ReplayableFencedRegistration {
  identity: ExactPortIdentity;
  replay: NodeSpawnPort['spawn'];
}

const retryablePreflightPorts = new WeakMap<NodeSpawnPort, ExactPortIdentity>();
const replayableFencedPorts = new WeakMap<NodeSpawnPort, ReplayableFencedRegistration>();

/**
 * Registers the exact built-in method set that may perform proven side-effect-
 * free preflight before publishing the durable dispatch fence. Replaced or
 * overridden methods remain untrusted and are fenced before entry.
 */
export function registerRetryablePreflightPort(
  port: NodeSpawnPort,
  identity: ExactPortIdentity,
): void {
  if (hasExactPortMethods(port, identity)) retryablePreflightPorts.set(port, identity);
}

/** Registers an internal handler whose server contract replays a fenced dispatch by idempotency key. */
export function registerReplayableFencedPort(
  port: NodeSpawnPort,
  identity: ExactPortIdentity,
  replay: NodeSpawnPort['spawn'],
): void {
  if (hasExactPortMethods(port, identity)) {
    replayableFencedPorts.set(port, { identity, replay });
  }
}

/** True only while the exact registered built-in method set remains installed. */
export function hasReplayableFencedDispatch(port: NodeSpawnPort): boolean {
  return replayableFencedRegistration(port) !== undefined;
}

function hasRetryablePreflight(port: NodeSpawnPort): boolean {
  const identity = retryablePreflightPorts.get(port);
  return identity !== undefined && hasExactPortMethods(port, identity);
}

function replayableFencedRegistration(
  port: NodeSpawnPort,
): ReplayableFencedRegistration | undefined {
  const registration = replayableFencedPorts.get(port);
  return registration !== undefined && hasExactPortMethods(port, registration.identity)
    ? registration : undefined;
}

function hasExactPortMethods(
  port: NodeSpawnPort,
  identity: ExactPortIdentity,
): boolean {
  if (Object.getPrototypeOf(port) !== identity.prototype
    || Object.getOwnPropertyDescriptor(port, 'spawn') !== undefined
    || Object.getOwnPropertyDescriptor(port, 'targets') !== undefined
    || Object.getOwnPropertyDescriptor(port, 'status') !== undefined
    || Object.getOwnPropertyDescriptor(port, 'release') !== undefined) return false;
  const spawn = Object.getOwnPropertyDescriptor(identity.prototype, 'spawn');
  const targets = Object.getOwnPropertyDescriptor(identity.prototype, 'targets');
  const status = Object.getOwnPropertyDescriptor(identity.prototype, 'status');
  const release = Object.getOwnPropertyDescriptor(identity.prototype, 'release');
  return spawn?.value === identity.spawn && targets?.value === identity.targets
    && status?.value === identity.status && release?.value === identity.release;
}

/** Enters exactly one irreversible spawn behind a durable, one-way fence. */
export async function dispatchFencedNodeSpawn(
  options: FencedNodeSpawnOptions,
): Promise<NodeSpawnReceipt> {
  const retryablePreflight = hasRetryablePreflight(options.port);
  let replay: NodeSpawnPort['spawn'] | undefined;
  let dispatchPublished = false;
  if (options.replayExistingFence === true) {
    if (!await hasNodeSpawnDispatchFence(options.claimPath, options.claim)) {
      throw new NodeSpawnError(
        'A fenced node-spawn replay requires the exact built-in replay contract and durable fence',
        'spawn_dispatch_fence_missing',
      );
    }
    // Recheck exact port identity after the asynchronous durable-fence read and
    // immediately before selecting the internal replay handler.
    replay = replayableFencedRegistration(options.port)?.replay;
    if (replay === undefined) {
      throw new NodeSpawnError(
        'A fenced node-spawn replay requires the exact built-in replay contract and durable fence',
        'spawn_dispatch_fence_missing',
      );
    }
    dispatchPublished = true;
  }
  let dispatchHookEntered = false;
  let pendingSpawn: Promise<NodeSpawnReceipt>;
  if (!retryablePreflight) {
    // Arbitrary public ports cannot prove that their own spawn preflight is
    // free of side effects. Publish before resolving or entering spawn, so a
    // process crash cannot leave a provider-contacted claim looking retryable.
    options.signal?.throwIfAborted();
    await claimNodeSpawnDispatch(options.claimPath, options.claim);
    dispatchPublished = true;
  }
  try {
    const spawn = replay ?? options.port.spawn.bind(options.port);
    pendingSpawn = spawn(options.request, async () => {
      dispatchHookEntered = true;
      options.signal?.throwIfAborted();
      if (dispatchPublished) return;
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
