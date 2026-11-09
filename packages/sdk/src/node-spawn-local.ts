import { isAbsolute, relative, sep } from 'node:path';

import {
  NodeSpawnError,
  normalizeNodeSpawnStatus,
  terminalStatus,
  type NodeReleaseRequest,
  type NodeSpawnAction,
  type NodeSpawnInvocation,
  type NodeSpawnPort,
  type NodeSpawnReceipt,
  type NodeSpawnRequest,
  type NodeSpawnTarget,
  validIdempotencyKey,
} from './node-spawn.js';

/** The structural core-bridge surface Flows consumes. Kept here so the package stays optional. */
export interface CoreBridgeClient {
  readonly hello: { methods: string[] };
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
  spawnInvoke(client: CoreBridgeClient, params: Record<string, unknown>, options?: { signal?: AbortSignal; actionTimeoutMs?: number }): Promise<CoreInvocation>;
  spawnStatus(client: CoreBridgeClient, params: Record<string, unknown>, options?: { signal?: AbortSignal }): Promise<CoreInvocation>;
  spawnRelease(client: CoreBridgeClient, params: Record<string, unknown>, options?: { signal?: AbortSignal; actionTimeoutMs?: number }): Promise<CoreInvocation>;
  serviceCallerInboxOpen(client: CoreBridgeClient, invocationId: string, options?: { signal?: AbortSignal }): Promise<{ iterator_id: string }>;
  serviceCallerInboxNext(client: CoreBridgeClient, iteratorId: string, timeoutMs: number, options?: { signal?: AbortSignal }): Promise<{ delivery: CoreInboxDelivery | null }>;
  serviceCallerInboxAck(client: CoreBridgeClient, itemId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  serviceCallerInboxFail(client: CoreBridgeClient, itemId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  serviceCallerInboxClose(client: CoreBridgeClient, iteratorId: string, options?: { signal?: AbortSignal }): Promise<unknown>;
  serviceCallerDisconnect(client: CoreBridgeClient, options?: { signal?: AbortSignal }): Promise<unknown>;
}

/** Loads the optional bridge without making remote-only installs depend on Desktop support. */
export async function loadCoreBridge(): Promise<CoreBridgeApi> {
  const specifier = '@agent-relay/core-bridge';
  try {
    return await import(specifier) as unknown as CoreBridgeApi;
  } catch (error) {
    throw new NodeSpawnError(
      'Local Desktop node spawn requires optional @agent-relay/core-bridge with schema-v2 service-caller support',
      'core_bridge_unavailable',
      error,
    );
  }
}

/** Native local spawn adapter over one already authenticated schema-v2 bridge connection. */
export class LocalNodeSpawnPort implements NodeSpawnPort {
  constructor(
    private readonly core: CoreBridgeClient,
    private readonly bridge: Pick<CoreBridgeApi, 'spawnTargets' | 'spawnInvoke' | 'spawnStatus' | 'spawnRelease'>,
    private readonly scope: Pick<CallerDescriptor, 'harnesses' | 'directoryScope'>,
  ) {}

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

  async spawn(request: NodeSpawnRequest): Promise<NodeSpawnReceipt> {
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
    const allTargets = await this.targets();
    const eligible = allTargets.filter(candidate => candidate.live && candidate.handlersLive
      && !candidate.stale && candidate.capabilities.includes(`spawn:${request.harness}`));
    const target = request.node === undefined
      ? eligible[0]
      : eligible.find(candidate => candidate.name === request.node);
    if (!target?.id) throw new NodeSpawnError('No eligible local Agent Relay spawn target', 'no_eligible_node');
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
    const settled = await this.wait('spawn', raw.id, request.timeoutMs);
    const settledTarget = allTargets.find(candidate => candidate.id === settled.nodeId);
    const cleanup = settled.agentId && settled.name && settledTarget?.id
      ? { id: settled.id, nodeId: settledTarget.id, nodeName: settledTarget.name,
        name: settled.name, agentId: settled.agentId }
      : undefined;
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
    if (!receipt.nodeId) {
      throw new NodeSpawnError('Local release requires the exact spawn node id', 'release_identity_mismatch');
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
      : await this.wait('release', raw.id);
    if (settled.status !== 'completed' || settled.released !== true) {
      throw new NodeSpawnError('The local node did not confirm exact agent release',
        settled.errorCode ?? 'release_unconfirmed');
    }
    return settled;
  }

  private async wait(action: NodeSpawnAction, id: string, timeoutMs = 360_000): Promise<NodeSpawnInvocation> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await this.status(action, id);
      if (terminalStatus(value.status)) return value;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new NodeSpawnError(`Timed out waiting for local ${action} confirmation`, `${action}_unconfirmed`);
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
