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
  repo?: string;
  timeoutMs?: number;
  sandboxOnly?: boolean;
}

export type NodeSpawnAction = 'spawn' | 'release';
export type NodeSpawnStatus = 'pending' | 'dispatched' | 'running' | 'completed' | 'failed';

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

export interface NodeReleaseRequest {
  receipt: NodeSpawnReceipt;
  idempotencyKey: string;
  reason?: string;
}

/** Credentials and transport stay inside an implementation of this port. */
export interface NodeSpawnPort {
  targets(): Promise<NodeSpawnTarget[]>;
  spawn(request: NodeSpawnRequest): Promise<NodeSpawnReceipt>;
  status(action: NodeSpawnAction, invocationId: string): Promise<NodeSpawnInvocation>;
  release(request: NodeReleaseRequest): Promise<NodeSpawnInvocation>;
}

export class NodeSpawnError extends Error {
  constructor(message: string, public readonly code = 'node_spawn_failed', public readonly cause?: unknown) {
    super(message);
    this.name = 'NodeSpawnError';
  }
}

export const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export const nonempty = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;

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
