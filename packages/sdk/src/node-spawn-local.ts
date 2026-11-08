import { createHash } from 'node:crypto';
import { existsSync, lstatSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { createConnection, type Socket } from 'node:net';
import {
  NodeSpawnError,
  type NodeReleaseRequest,
  type NodeSpawnAction,
  type NodeSpawnInvocation,
  type NodeSpawnPort,
  type NodeSpawnReceipt,
  type NodeSpawnRequest,
  type NodeSpawnTarget,
  validIdempotencyKey,
} from './node-spawn.js';

const BRIDGE_VERSION = 2;
const DEFAULT_TIMEOUT_MS = 15_000;

export interface CoreClient {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
  close(): void;
}

export function coreSocketPath(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  const fallback = join(home, '.agentworkforce', 'desktop', 'core.sock');
  const configured = env.AGENT_RELAY_CORE_SOCKET?.trim();
  if (!configured) return fallback;
  return isAbsolute(configured) ? configured : join(dirname(fallback), configured);
}

function pipeName(socket: string): string {
  let key = socket.replace(/\//g, '\\').toLowerCase();
  if (key.startsWith('\\\\?\\')) key = key.slice(4);
  while (key.length > 1 && key.endsWith('\\')) key = key.slice(0, -1);
  return `\\\\.\\pipe\\agent-relay-${createHash('sha256').update(key).digest('hex').slice(0, 16)}`;
}

function verifySocket(socket: string): void {
  if (process.platform === 'win32' || typeof process.getuid !== 'function') return;
  const directory = dirname(socket);
  const entry = lstatSync(directory);
  const target = statSync(directory);
  if (entry.uid !== process.getuid() || target.uid !== process.getuid()
    || !target.isDirectory() || (target.mode & 0o022) !== 0) {
    throw new NodeSpawnError('The Agent Relay core socket directory is not private to this user', 'untrusted_core_socket');
  }
  const file = lstatSync(socket);
  if (!file.isSocket() || file.uid !== process.getuid() || (file.mode & 0o077) !== 0) {
    throw new NodeSpawnError('The Agent Relay core socket is not private to this user', 'untrusted_core_socket');
  }
}

/** Connects to Desktop's credential-holding core bridge; never starts a daemon. */
export async function connectCore(socket = coreSocketPath(), timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CoreClient | undefined> {
  if (process.platform !== 'win32') {
    if (!existsSync(socket)) return undefined;
    verifySocket(socket);
  }
  const stream = await openSocket(process.platform === 'win32' ? pipeName(socket) : socket, timeoutMs);
  if (!stream) return undefined;
  let nextId = 1;
  let buffer = '';
  let closed = false;
  const pending = new Map<number, { resolve(value: unknown): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  const fail = (error: Error) => {
    closed = true;
    for (const waiter of pending.values()) { clearTimeout(waiter.timer); waiter.reject(error); }
    pending.clear();
  };
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    buffer += chunk;
    for (let newline = buffer.indexOf('\n'); newline >= 0; newline = buffer.indexOf('\n')) {
      const line = buffer.slice(0, newline);
      buffer = buffer.slice(newline + 1);
      let message: { id?: unknown; result?: unknown; error?: { message?: string } };
      try { message = JSON.parse(line); } catch { continue; }
      if (typeof message.id !== 'number') continue;
      const waiter = pending.get(message.id);
      if (!waiter) continue;
      pending.delete(message.id);
      clearTimeout(waiter.timer);
      if (message.error) waiter.reject(new NodeSpawnError(message.error.message ?? 'The Agent Relay core refused the request'));
      else waiter.resolve(message.result ?? null);
    }
  });
  stream.on('error', error => fail(error));
  stream.on('close', () => fail(new NodeSpawnError('The Agent Relay core closed the connection')));
  const client: CoreClient = {
    call<T>(method: string, params: Record<string, unknown> = {}): Promise<T> {
      if (closed) return Promise.reject(new NodeSpawnError('The Agent Relay core connection is closed'));
      const id = nextId++;
      return new Promise<T>((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new NodeSpawnError(`The Agent Relay core did not answer ${method} in time`, 'core_timeout'));
        }, timeoutMs);
        pending.set(id, { resolve: value => resolve(value as T), reject, timer });
        stream.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    close() { closed = true; stream.destroy(); },
  };
  try {
    const hello = await client.call<{ bridge_version?: unknown }>('hello', { bridge_version: BRIDGE_VERSION });
    if (hello.bridge_version !== BRIDGE_VERSION) {
      throw new NodeSpawnError('The process at the core socket does not speak Agent Relay bridge v2', 'core_version_mismatch');
    }
  } catch (error) { client.close(); throw error; }
  return client;
}

async function openSocket(address: string, timeoutMs: number): Promise<Socket | undefined> {
  return new Promise(resolve => {
    const socket = createConnection(address);
    const timer = setTimeout(() => { socket.destroy(); resolve(undefined); }, timeoutMs);
    socket.once('connect', () => { clearTimeout(timer); resolve(socket); });
    socket.once('error', () => { clearTimeout(timer); resolve(undefined); });
  });
}

interface CoreInvocation {
  id: string;
  agent_id?: string;
  status: string;
  node_id?: string;
  name?: string;
  spawned: boolean;
  ready: boolean;
  released?: boolean;
  task_unconfirmed: boolean;
  error_code?: string;
}

/**
 * Local native-spawn adapter. The caller name is deliberately explicit: this
 * class never borrows a Desktop registration or provisions a service caller.
 */
export class LocalNodeSpawnPort implements NodeSpawnPort {
  constructor(private readonly core: CoreClient, private readonly callerName: string) {
    if (!callerName.trim()) throw new NodeSpawnError('Local node spawn requires an explicitly authorized caller name', 'caller_required');
  }

  async targets(): Promise<NodeSpawnTarget[]> {
    const result = await this.core.call<{ targets: Array<Record<string, unknown>> }>('spawn.targets');
    if (!Array.isArray(result.targets)) throw new NodeSpawnError('The core returned invalid spawn targets');
    return result.targets.map(value => ({
      id: String(value.id), name: String(value.name), live: value.live === true,
      handlersLive: value.handlers_live === true, stale: value.stale === true,
      capabilities: Array.isArray(value.capabilities) ? value.capabilities.filter(v => typeof v === 'string') : [],
      activeAgents: Number(value.active_agents), reservedAgents: Number(value.reserved_agents), maxAgents: Number(value.max_agents),
    }));
  }

  async spawn(request: NodeSpawnRequest): Promise<NodeSpawnReceipt> {
    if (!request.directory || !isAbsolute(request.directory)) throw new NodeSpawnError('Local node spawn requires an absolute directory', 'spawn_invalid_input');
    if (!validIdempotencyKey(request.idempotencyKey)) throw new NodeSpawnError('Invalid node-spawn idempotency key', 'spawn_invalid_input');
    const targets = (await this.targets()).filter(candidate => candidate.live && candidate.handlersLive
      && !candidate.stale && candidate.capabilities.includes(`spawn:${request.harness}`));
    const target = request.node === undefined
      ? targets[0]
      : targets.find(candidate => candidate.name === request.node);
    if (!target?.id) throw new NodeSpawnError('No eligible local Agent Relay spawn target', 'no_eligible_node');
    const raw = await this.core.call<CoreInvocation>('spawn.invoke', {
      caller_name: this.callerName, node_id: target.id, node_name: target.name,
      name: request.name, harness: request.harness, task: request.task,
      directory: request.directory, idempotency_key: request.idempotencyKey,
    });
    // spawn.invoke is the action receipt; spawn.status is also the boundary
    // that enriches it from the core's exact same-workspace registration.
    const settled = await this.wait('spawn', raw.id, request.timeoutMs);
    if (settled.status !== 'completed' || !settled.spawned || !settled.ready || !settled.agentId || !settled.name) {
      throw new NodeSpawnError('The local node did not prove a ready spawned agent', settled.errorCode);
    }
    return { ...settled, action: 'spawn', nodeName: target.name, name: settled.name,
      agentId: settled.agentId, spawned: true, ready: true };
  }

  async status(action: NodeSpawnAction, invocationId: string): Promise<NodeSpawnInvocation> {
    const raw = await this.core.call<CoreInvocation>('spawn.status', {
      caller_name: this.callerName, action, invocation_id: invocationId,
    });
    return mapCoreInvocation(action, raw);
  }

  async release(request: NodeReleaseRequest): Promise<NodeSpawnInvocation> {
    if (!validIdempotencyKey(request.idempotencyKey)) throw new NodeSpawnError('Invalid node-release idempotency key', 'spawn_invalid_input');
    const receipt = request.receipt;
    if (!receipt.nodeId) throw new NodeSpawnError('Local release requires the exact spawn node id', 'release_identity_mismatch');
    const raw = await this.core.call<CoreInvocation>('spawn.release', {
      caller_name: this.callerName, node_id: receipt.nodeId, node_name: receipt.nodeName,
      name: receipt.name, expected_agent_id: receipt.agentId, idempotency_key: request.idempotencyKey,
    });
    const settled = raw.status === 'completed' ? mapCoreInvocation('release', raw) : await this.wait('release', raw.id);
    if (settled.status !== 'completed' || settled.released !== true) {
      throw new NodeSpawnError('The local node did not confirm exact agent release', settled.errorCode ?? 'release_unconfirmed');
    }
    return settled;
  }

  private async wait(action: NodeSpawnAction, id: string, timeoutMs = 360_000): Promise<NodeSpawnInvocation> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = await this.status(action, id);
      if (value.status === 'completed' || value.status === 'failed') return value;
      await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new NodeSpawnError(`Timed out waiting for local ${action} confirmation`, `${action}_unconfirmed`);
  }
}

function mapCoreInvocation(action: NodeSpawnAction, value: CoreInvocation): NodeSpawnInvocation {
  return {
    id: value.id, action, status: value.status as NodeSpawnInvocation['status'],
    nodeId: value.node_id, name: value.name, agentId: value.agent_id,
    spawned: value.spawned, ready: value.ready, taskUnconfirmed: value.task_unconfirmed,
    released: value.released,
    errorCode: value.error_code,
  };
}
