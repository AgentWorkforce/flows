/** Native Agent Relay node-spawn contract used by Flows. */
export interface NodeSpawnTarget {
  id?: string;
  name: string;
  live: boolean;
  handlersLive: boolean;
  stale?: boolean;
  capabilities: string[];
  activeAgents?: number;
  reservedAgents?: number;
  maxAgents?: number;
}

export interface NodeSpawnRequest {
  name: string;
  harness: string;
  task: string;
  model?: string;
  directory?: string;
  idempotencyKey: string;
  node?: string;
  /** Exact local node identity retained only for durable fenced replay. */
  nodeId?: string;
  repo?: string;
  timeoutMs?: number;
  sandboxOnly?: boolean;
}

export type NodeSpawnAction = 'spawn' | 'release';
export type NodeSpawnStatus = 'pending' | 'dispatched' | 'running' | 'completed' | 'failed'
  | 'denied' | 'cancelled' | 'timed_out';

export interface NodeSpawnInvocation {
  id: string;
  action: NodeSpawnAction;
  status: NodeSpawnStatus;
  nodeId?: string;
  nodeName?: string;
  name?: string;
  agentId?: string;
  spawned: boolean;
  ready: boolean;
  released?: boolean;
  taskUnconfirmed?: boolean;
  errorCode?: string;
}

export interface NodeSpawnReceipt extends NodeSpawnInvocation {
  action: 'spawn';
  name: string;
  agentId: string;
  nodeName: string;
  spawned: true;
  ready: true;
}

/** Exact identity sufficient for a safe release, even when readiness failed. */
export interface NodeSpawnIdentity {
  id: string;
  nodeId?: string;
  nodeName: string;
  name: string;
  agentId: string;
}

export interface NodeReleaseRequest {
  receipt: NodeSpawnIdentity;
  idempotencyKey: string;
  reason?: string;
}

/** Requests the durable write-ahead fact before an irreversible spawn call. */
export type BeforeNodeDispatch = () => Promise<void>;

/** Credentials and transport stay inside an implementation of this port. */
export interface NodeSpawnPort {
  /** Declares participation in the durable dispatch-fence protocol. */
  readonly dispatchFenceVersion: 1;
  targets(): Promise<NodeSpawnTarget[]>;
  spawn(request: NodeSpawnRequest, beforeDispatch: BeforeNodeDispatch): Promise<NodeSpawnReceipt>;
  status(action: NodeSpawnAction, invocationId: string): Promise<NodeSpawnInvocation>;
  release(request: NodeReleaseRequest): Promise<NodeSpawnInvocation>;
}

export class NodeSpawnError extends Error {
  constructor(
    message: string,
    public readonly code = 'node_spawn_failed',
    public readonly cause?: unknown,
    /** Exact identity to release when spawn happened but later verification failed. */
    public readonly cleanup?: NodeSpawnIdentity,
  ) {
    super(message);
    this.name = 'NodeSpawnError';
  }
}

/** An official port proved that it failed before entering its dispatch hook. */
export class NodeSpawnPreDispatchError extends NodeSpawnError {
  constructor(error: unknown) {
    super(
      error instanceof Error ? error.message : 'Node-spawn preflight failed',
      error instanceof NodeSpawnError ? error.code : 'node_spawn_preflight_failed',
      error,
    );
    this.name = 'NodeSpawnPreDispatchError';
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

export function validNodeSpawnIdentity(value: unknown): value is NodeSpawnIdentity {
  if (!isRecord(value)) return false;
  return [value.id, value.nodeName, value.name, value.agentId].every(nonempty)
    && (value.nodeId === undefined || nonempty(value.nodeId));
}

export function validNodeSpawnReceipt(value: unknown): value is NodeSpawnReceipt {
  return validNodeSpawnIdentity(value)
    && (value as unknown as Record<string, unknown>).action === 'spawn'
    && (value as unknown as Record<string, unknown>).status === 'completed'
    && (value as unknown as Record<string, unknown>).spawned === true
    && (value as unknown as Record<string, unknown>).ready === true;
}

export function validSegment(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 200
    && /^[A-Za-z0-9_-]+$/.test(value);
}

export function validIdempotencyKey(value: unknown): value is string {
  return validSegment(value) && value.length >= 16;
}

export function terminalStatus(status: string): boolean {
  return ['completed', 'failed', 'denied', 'cancelled', 'canceled', 'timed_out', 'timeout'].includes(status);
}

export function normalizeNodeSpawnStatus(status: string): NodeSpawnStatus {
  const normalized = status.toLowerCase();
  if (normalized === 'completed') return 'completed';
  if (normalized === 'denied') return 'denied';
  if (normalized === 'cancelled' || normalized === 'canceled') return 'cancelled';
  if (normalized === 'timed_out' || normalized === 'timeout') return 'timed_out';
  if (normalized === 'failed') return 'failed';
  if (normalized === 'running') return 'running';
  if (normalized === 'dispatched') return 'dispatched';
  return 'pending';
}
