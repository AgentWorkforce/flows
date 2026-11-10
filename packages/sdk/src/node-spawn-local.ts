import { isAbsolute, relative, sep } from 'node:path';

import {
  NodeSpawnError,
  NodeSpawnPreDispatchError,
  normalizeNodeSpawnStatus,
  terminalStatus,
  type NodeReleaseRequest,
  type NodeSpawnAction,
  type NodeSpawnInvocation,
  type NodeSpawnIdentity,
  type NodeSpawnPort,
  type NodeSpawnReceipt,
  type NodeSpawnRequest,
  type NodeSpawnTarget,
  validIdempotencyKey,
  type BeforeNodeDispatch,
} from './node-spawn.js';
import { registerOfficialNodeSpawnPort } from './node-spawn-dispatch.js';

/** The structural core-bridge surface Flows consumes. Kept here so the package stays optional. */
export interface CoreBridgeClient {
  readonly hello: {
    bridge_version: number;
    daemon_version: string;
    pid: number;
    methods: string[];
    topics: Array<'status' | 'activity' | 'shutdown' | 'invalidated' | 'notify' | 'sign_in'>;
  };
  close(): void;
}

export interface CallerDescriptor {
  readonly schema: 'agent-relay-service-caller/2';
  readonly schemaVersion: 2;
  readonly auth: unknown;
  readonly callerId: string;
  readonly callerName: string;
  readonly publisher: { readonly id: string; readonly name: string };
  readonly workspace: {
    readonly site_url: string;
    readonly base_url: string;
    readonly workspace_id: string;
    readonly relaycast_workspace_id: string;
  };
  readonly account: { readonly user_id: string };
  readonly credential: unknown;
  readonly createdAt: string;
  readonly rotatedAt?: string;
  readonly expiresAt: string;
  readonly harnesses: readonly string[];
  readonly directoryScope: readonly string[];
  readonly ownsOnly: boolean;
  readonly socket: string;
  readonly inbox: {
    readonly transport: string;
    readonly open: string;
    readonly next: string;
    readonly ack: string;
    readonly fail: string;
    readonly close: string;
    readonly disconnect: string;
  };
  readonly desktopVersion: string;
}

interface CoreTarget {
  id: string;
  name: string;
  live: boolean;
  handlers_live: boolean;
  stale: boolean;
  capabilities: string[];
  active_agents: number;
  reserved_agents: number;
  max_agents: number;
}

interface CoreInvocation {
  id: string;
  agent_id: string | null;
  status: string;
  node_id: string | null;
  name: string | null;
  spawned: boolean;
  ready: boolean;
  released: boolean;
  task_unconfirmed: boolean;
  error_code: string | null;
}

interface CoreSpawnInvokeParams {
  caller_name?: string;
  node_id: string;
  node_name: string;
  name: string;
  harness: string;
  task: string;
  directory: string;
  idempotency_key: string;
}

interface CoreSpawnStatusParams {
  caller_name?: string;
  action: NodeSpawnAction;
  invocation_id: string;
}

interface CoreSpawnReleaseParams {
  caller_name?: string;
  node_id: string;
  node_name: string;
  name: string;
  expected_agent_id: string;
  idempotency_key: string;
}

export interface CoreInboxDelivery {
  item_id: string;
  message_id: string;
  sender: { id: string; name: string };
  text?: string;
  failure?: { code: 'result_too_large' | 'result_write_failed'; bytes: number; limit: number };
  invocation_id: string;
  sent_at: string;
}

/** Typed API required from @agent-relay/core-bridge's schema-v2 release. */
export interface CoreBridgeApi {
  connectCore(options?: { socket?: string; signal?: AbortSignal }): Promise<CoreBridgeClient>;
  readCallerDescriptor(path: string): Promise<CallerDescriptor>;
  authenticate(client: CoreBridgeClient, credential: unknown, options?: { signal?: AbortSignal }): Promise<unknown>;
  requireServiceCallerMethods(client: CoreBridgeClient): void;
  assertServiceCallerIdentity(
    descriptor: CallerDescriptor,
    identity: Awaited<ReturnType<CoreBridgeApi['serviceCallerIdentity']>>,
  ): void;
  serviceCallerIdentity(client: CoreBridgeClient, options?: { signal?: AbortSignal }): Promise<{
    publisher: { id: string; name: string };
    node: { id: string; name: string };
    base_url: string;
    workspace_id: string;
    relaycast_workspace_id: string;
  }>;
  spawnTargets(client: CoreBridgeClient, options?: { signal?: AbortSignal }): Promise<{ targets: CoreTarget[] }>;
  spawnInvoke(client: CoreBridgeClient, params: CoreSpawnInvokeParams, options?: { signal?: AbortSignal; actionTimeoutMs?: number }): Promise<CoreInvocation>;
  spawnStatus(client: CoreBridgeClient, params: CoreSpawnStatusParams, options?: { signal?: AbortSignal }): Promise<CoreInvocation>;
  spawnRelease(client: CoreBridgeClient, params: CoreSpawnReleaseParams, options?: { signal?: AbortSignal; actionTimeoutMs?: number }): Promise<CoreInvocation>;
  serviceCallerInboxOpen(client: CoreBridgeClient, invocationId: string, options?: { signal?: AbortSignal }): Promise<{ iterator_id: string }>;
  serviceCallerInboxNext(client: CoreBridgeClient, iteratorId: string, timeoutMs: number, options?: { signal?: AbortSignal }): Promise<{ delivery: CoreInboxDelivery | null }>;
  serviceCallerInboxAck(client: CoreBridgeClient, itemId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  serviceCallerInboxFail(client: CoreBridgeClient, itemId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  serviceCallerInboxClose(client: CoreBridgeClient, iteratorId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  serviceCallerDisconnect(client: CoreBridgeClient, options?: { signal?: AbortSignal }): Promise<unknown>;
}

const REQUIRED_CORE_BRIDGE_METHODS = {
  connectCore: true,
  readCallerDescriptor: true,
  authenticate: true,
  requireServiceCallerMethods: true,
  assertServiceCallerIdentity: true,
  serviceCallerIdentity: true,
  spawnTargets: true,
  spawnInvoke: true,
  spawnStatus: true,
  spawnRelease: true,
  serviceCallerInboxOpen: true,
  serviceCallerInboxNext: true,
  serviceCallerInboxAck: true,
  serviceCallerInboxFail: true,
  serviceCallerInboxClose: true,
  serviceCallerDisconnect: true,
} as const satisfies Record<keyof CoreBridgeApi, true>;

/** Fails before local admission when an installed optional bridge lacks the required contract. */
export function assertCoreBridgeApi(value: unknown): asserts value is CoreBridgeApi {
  const module = (typeof value === 'object' && value !== null)
    ? value as Record<string, unknown>
    : {};
  const missingMethods = Object.keys(REQUIRED_CORE_BRIDGE_METHODS)
    .filter(method => typeof module[method] !== 'function');
  if (missingMethods.length === 0) return;
  throw new NodeSpawnError(
    `Installed @agent-relay/core-bridge is missing required schema-v2 methods: ${missingMethods.join(', ')}. `
      + 'Install >=18.1.0 <19.',
    'core_bridge_unavailable',
    { missingMethods, requiredVersion: '>=18.1.0 <19' },
  );
}

/** Loads the optional bridge without making remote-only installs depend on Desktop support. */
export async function loadCoreBridge(): Promise<CoreBridgeApi> {
  const specifier = '@agent-relay/core-bridge';
  let bridge: unknown;
  try {
    bridge = await import(specifier);
  } catch (error) {
    throw new NodeSpawnError(
      'Local Desktop node spawn requires optional @agent-relay/core-bridge >=18.1.0 <19 '
        + 'with schema-v2 service-caller support',
      'core_bridge_unavailable',
      error,
    );
  }
  assertCoreBridgeApi(bridge);
  return bridge;
}

/** Native local spawn adapter over one already authenticated schema-v2 bridge connection. */
export class LocalNodeSpawnPort implements NodeSpawnPort {
  readonly dispatchFenceVersion = 1 as const;

  constructor(
    private readonly core: CoreBridgeClient,
    private readonly bridge: Pick<CoreBridgeApi, 'spawnTargets' | 'spawnInvoke' | 'spawnStatus' | 'spawnRelease'>,
    private readonly scope: Pick<CallerDescriptor, 'harnesses' | 'directoryScope'>,
    private readonly exactNode: { readonly id: string; readonly name: string },
  ) {
    registerOfficialNodeSpawnPort(this, LocalNodeSpawnPort.prototype.spawn);
  }

  async targets(): Promise<NodeSpawnTarget[]> {
    const result = await this.bridge.spawnTargets(this.core);
    if (!result || !Array.isArray(result.targets)) {
      throw new NodeSpawnError('The core returned invalid spawn targets', 'invalid_core_response');
    }
    return result.targets.map(value => {
      if (!value || typeof value.id !== 'string' || value.id === ''
        || typeof value.name !== 'string' || value.name === '') {
        throw new NodeSpawnError('The core returned a spawn target without an exact identity', 'invalid_core_response');
      }
      return {
        id: value.id,
        name: value.name,
        live: value.live === true,
        handlersLive: value.handlers_live === true,
        stale: value.stale === true,
        capabilities: Array.isArray(value.capabilities)
          ? value.capabilities.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0)
          : [],
        activeAgents: Number(value.active_agents),
        reservedAgents: Number(value.reserved_agents),
        maxAgents: Number(value.max_agents),
      };
    });
  }

  async spawn(request: NodeSpawnRequest, beforeDispatch: BeforeNodeDispatch): Promise<NodeSpawnReceipt> {
    let allTargets: NodeSpawnTarget[];
    let target: NodeSpawnTarget | undefined;
    try {
      if (!request.directory || !isAbsolute(request.directory)) {
        throw new NodeSpawnError('Local node spawn requires an absolute directory', 'spawn_invalid_input');
      }
      if (!this.scope.harnesses.includes(request.harness)
        || !this.scope.directoryScope.some(root => withinDirectory(root, request.directory!))) {
        throw new NodeSpawnError(
          'The Desktop service caller does not authorize this harness and directory',
          'outside_scope',
        );
      }
      if (!validIdempotencyKey(request.idempotencyKey)) {
        throw new NodeSpawnError('Invalid node-spawn idempotency key', 'spawn_invalid_input');
      }
      if (request.model !== undefined || request.repo !== undefined || request.sandboxOnly !== undefined) {
        throw new NodeSpawnError(
          'The Desktop core bridge does not accept model, repository, or sandbox placement overrides',
          'spawn_invalid_input',
        );
      }
      allTargets = await this.targets();
      if (request.node !== undefined && request.node !== this.exactNode.name) {
        throw new NodeSpawnError('The requested node differs from the authenticated Desktop node',
          'spawn_identity_mismatch');
      }
      target = allTargets.find(candidate => candidate.id === this.exactNode.id
        && candidate.name === this.exactNode.name
        && candidate.live && candidate.handlersLive && !candidate.stale
        && candidate.capabilities.includes(`spawn:${request.harness}`));
      if (!target?.id) {
        throw new NodeSpawnError('No eligible local Agent Relay spawn target', 'no_eligible_node');
      }
    } catch (error) {
      throw new NodeSpawnPreDispatchError(error);
    }
    await beforeDispatch();
    const raw = await this.bridge.spawnInvoke(this.core, {
      node_id: target.id,
      node_name: target.name,
      name: request.name,
      harness: request.harness,
      task: request.task,
      directory: request.directory,
      idempotency_key: request.idempotencyKey,
    }, { actionTimeoutMs: request.timeoutMs });
    // spawn.invoke is the action receipt; spawn.status is also the boundary
    // that enriches it from the core's exact same-workspace registration.
    const confirmation = await this.wait('spawn', raw.id, request.timeoutMs,
      mapCoreInvocation('spawn', raw));
    const settled = confirmation.invocation;
    const settledTarget = allTargets.find(candidate => candidate.id === settled.nodeId);
    const cleanup = confirmation.cleanup ?? (settled.agentId && settled.name && settledTarget?.id
      ? { id: settled.id, nodeId: settledTarget.id, nodeName: settledTarget.name,
        name: settled.name, agentId: settled.agentId }
      : undefined);
    if (settled.status !== 'completed' || !settled.spawned || !settled.ready
      || settled.taskUnconfirmed !== false || !settled.agentId || !settled.name) {
      throw new NodeSpawnError('The local node did not prove a ready spawned agent',
        settled.taskUnconfirmed !== false ? 'spawn_task_unconfirmed' : settled.errorCode, undefined, cleanup);
    }
    if (settled.name !== request.name || settled.nodeId !== target.id) {
      throw new NodeSpawnError('The local spawn result did not preserve its requested identity',
        'spawn_identity_mismatch', undefined, cleanup);
    }
    return { ...settled, action: 'spawn', nodeName: target.name, name: settled.name,
      agentId: settled.agentId, spawned: true, ready: true };
  }

  async status(action: NodeSpawnAction, invocationId: string): Promise<NodeSpawnInvocation> {
    return mapCoreInvocation(action, await this.bridge.spawnStatus(this.core, {
      action,
      invocation_id: invocationId,
    }));
  }

  async release(request: NodeReleaseRequest): Promise<NodeSpawnInvocation> {
    if (!validIdempotencyKey(request.idempotencyKey)) {
      throw new NodeSpawnError('Invalid node-release idempotency key', 'spawn_invalid_input');
    }
    const receipt = request.receipt;
    if (!receipt.nodeId || receipt.nodeId !== this.exactNode.id
      || receipt.nodeName !== this.exactNode.name) {
      throw new NodeSpawnError('Local release requires the authenticated Desktop node identity',
        'release_identity_mismatch');
    }
    const raw = await this.bridge.spawnRelease(this.core, {
      node_id: receipt.nodeId,
      node_name: receipt.nodeName,
      name: receipt.name,
      expected_agent_id: receipt.agentId,
      idempotency_key: request.idempotencyKey,
    });
    const settled = raw.status === 'completed'
      ? mapCoreInvocation('release', raw)
      : (await this.wait('release', raw.id)).invocation;
    if (settled.status !== 'completed' || settled.released !== true) {
      throw new NodeSpawnError('The local node did not confirm exact agent release',
        settled.errorCode ?? 'release_unconfirmed');
    }
    return settled;
  }

  private async wait(
    action: NodeSpawnAction,
    id: string,
    timeoutMs = 360_000,
    initial?: NodeSpawnInvocation,
  ): Promise<{ invocation: NodeSpawnInvocation; cleanup?: NodeSpawnIdentity }> {
    const deadline = Date.now() + timeoutMs;
    let cleanup = this.cleanupIdentity(action, initial);
    while (Date.now() < deadline) {
      let value: NodeSpawnInvocation;
      try {
        value = await this.status(action, id);
      } catch (error) {
        if (cleanup === undefined) throw error;
        if (error instanceof NodeSpawnError) {
          throw new NodeSpawnError(error.message, error.code, error.cause ?? error, cleanup);
        }
        throw new NodeSpawnError(`Could not confirm local ${action}`, `${action}_unconfirmed`, error, cleanup);
      }
      const observed = this.cleanupIdentity(action, value);
      if (cleanup !== undefined && value.spawned === true
        && ((value.id !== '' && cleanup.id !== value.id)
          || (value.nodeId !== undefined && cleanup.nodeId !== value.nodeId)
          || (value.name !== undefined && cleanup.name !== value.name)
          || (value.agentId !== undefined && cleanup.agentId !== value.agentId))) {
        throw new NodeSpawnError('The local spawn confirmation changed its exact identity',
          'spawn_identity_mismatch', undefined, cleanup);
      }
      cleanup ??= observed;
      if (terminalStatus(value.status)) return { invocation: value, cleanup };
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new NodeSpawnError(`Timed out waiting for local ${action} confirmation`,
      `${action}_unconfirmed`, undefined, cleanup);
  }

  private cleanupIdentity(
    action: NodeSpawnAction,
    value?: NodeSpawnInvocation,
  ): NodeSpawnIdentity | undefined {
    if (action !== 'spawn' || value?.spawned !== true || value.id.trim() === ''
      || value.nodeId !== this.exactNode.id || !value.name || value.name.trim() === ''
      || !value.agentId || value.agentId.trim() === '') return undefined;
    return { id: value.id, nodeId: value.nodeId, nodeName: this.exactNode.name,
      name: value.name, agentId: value.agentId };
  }
}

function withinDirectory(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${sep}`)
    && !isAbsolute(path));
}

function mapCoreInvocation(action: NodeSpawnAction, value: CoreInvocation): NodeSpawnInvocation {
  return {
    id: value.id,
    action,
    status: normalizeNodeSpawnStatus(value.status),
    nodeId: value.node_id ?? undefined,
    name: value.name ?? undefined,
    agentId: value.agent_id ?? undefined,
    spawned: value.spawned,
    ready: value.ready,
    taskUnconfirmed: value.task_unconfirmed,
    released: value.released,
    errorCode: value.error_code ?? undefined,
  };
}
