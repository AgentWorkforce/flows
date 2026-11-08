import { isIP } from 'node:net';
import type { NodeResultInboxClient } from './node-spawn-result.js';
import { NodeSpawnError } from './node-spawn.js';
import { RemoteNodeSpawnPort, type RemoteNodeSpawnClient } from './node-spawn-remote.js';
import type { NodeSpawnPort } from './node-spawn.js';

export interface NodeSpawnPublisher { id: string; name: string }
export interface NodeSpawnRuntime {
  port: NodeSpawnPort;
  inbox: NodeResultInboxClient;
  publisher: NodeSpawnPublisher;
  baseUrl: string;
  node?: string;
  repo?: string;
  sandboxOnly?: boolean;
  /** Closes the publisher connection after every task using it has drained. */
  disconnect?(): Promise<void>;
}

export interface NodeSpawnRuntimeOwner {
  get(signal?: AbortSignal): Promise<NodeSpawnRuntime>;
  close(): Promise<void>;
}

interface RelayRuntimeClient extends RemoteNodeSpawnClient, NodeResultInboxClient {
  agents: RemoteNodeSpawnClient['agents'] & { me(): Promise<NodeSpawnPublisher> };
  events: { disconnect(): Promise<void> };
}

const PUBLISHER_DISCOVERY_TIMEOUT_MS = 15_000;

export async function createRemoteNodeSpawnRuntime(
  env: NodeJS.ProcessEnv = process.env,
  options: { signal?: AbortSignal } = {},
): Promise<NodeSpawnRuntime> {
  const agentToken = env.RELAY_AGENT_TOKEN?.trim();
  if (!agentToken) throw new NodeSpawnError(
    'Node-spawn transport requires a dedicated publisher RELAY_AGENT_TOKEN.', 'publisher_token_required');
  const baseUrl = validateNodeSpawnBaseUrl(env.RELAY_BASE_URL?.trim() || 'https://cast.agentrelay.com');
  let RelaycastMessagingClient: new (options: Record<string, unknown>) => RelayRuntimeClient;
  try {
    ({ RelaycastMessagingClient } = await import('@agent-relay/sdk') as unknown as {
      RelaycastMessagingClient: new (options: Record<string, unknown>) => RelayRuntimeClient;
    });
  } catch (error) {
    throw new NodeSpawnError('Node-spawn transport requires optional @agent-relay/sdk >=17.2.1 <18.',
      'relay_sdk_unavailable', error);
  }
  const sandbox = env.RELAYFLOW_NODE_SANDBOX_ONLY?.trim();
  if (sandbox !== undefined && sandbox !== '' && sandbox !== '0' && sandbox !== '1') {
    throw new NodeSpawnError('RELAYFLOW_NODE_SANDBOX_ONLY must be 0 or 1', 'spawn_invalid_input');
  }
  const client = new RelaycastMessagingClient({ baseUrl, agentToken });
  const timeout = AbortSignal.timeout(PUBLISHER_DISCOVERY_TIMEOUT_MS);
  const signal = options.signal === undefined ? timeout : AbortSignal.any([options.signal, timeout]);
  let publisher: NodeSpawnPublisher;
  try {
    publisher = await discoverPublisher(client, signal);
    if (!publisher.id?.trim() || !publisher.name?.trim()) {
      throw new NodeSpawnError('The node-spawn publisher token has no exact Relay identity', 'publisher_identity_missing');
    }
  } catch (error) {
    await client.events.disconnect().catch(() => undefined);
    throw error;
  }
  return {
    port: new RemoteNodeSpawnPort(client),
    inbox: { inbox: client.inbox },
    publisher,
    baseUrl,
    disconnect: () => client.events.disconnect(),
    ...(env.RELAYFLOW_NODE_NAME?.trim() ? { node: env.RELAYFLOW_NODE_NAME.trim() } : {}),
    ...(env.RELAYFLOW_NODE_REPO?.trim() ? { repo: env.RELAYFLOW_NODE_REPO.trim() } : {}),
    ...(sandbox === '1' ? { sandboxOnly: true } : {}),
  };
}

/** One lazy publisher connection shared by every relay task on a worker. */
export function createNodeSpawnRuntimeOwner(
  provided?: NodeSpawnRuntime,
  factory: (signal: AbortSignal) => Promise<NodeSpawnRuntime> = signal =>
    createRemoteNodeSpawnRuntime(process.env, { signal }),
): NodeSpawnRuntimeOwner {
  const controller = new AbortController();
  let pending: Promise<NodeSpawnRuntime> | undefined;
  let closed = false;
  let closePromise: Promise<void> | undefined;
  const get = async (signal?: AbortSignal): Promise<NodeSpawnRuntime> => {
    signal?.throwIfAborted();
    if (closed) throw new NodeSpawnError('Node-spawn runtime owner is closed', 'task_cancelled');
    if (provided !== undefined) return provided;
    if (pending === undefined) {
      const created = factory(controller.signal);
      pending = created;
      void created.catch(() => { if (pending === created) pending = undefined; });
    }
    return waitForRuntime(pending, signal);
  };
  const closeOnce = async (): Promise<void> => {
    closed = true;
    controller.abort(new Error('Node-spawn runtime owner closed'));
    if (provided !== undefined) return;
    const runtime = await pending?.catch(() => undefined);
    await runtime?.disconnect?.().catch(() => undefined);
  };
  return { get, close: () => closePromise ??= closeOnce() };
}

async function waitForRuntime(pending: Promise<NodeSpawnRuntime>, signal?: AbortSignal): Promise<NodeSpawnRuntime> {
  if (signal === undefined) return pending;
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([pending, aborted]); }
  finally { if (onAbort !== undefined) signal.removeEventListener('abort', onAbort); }
}

async function discoverPublisher(client: RelayRuntimeClient, signal: AbortSignal): Promise<NodeSpawnPublisher> {
  let onAbort: (() => void) | undefined;
  try {
    signal.throwIfAborted();
    const aborted = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
      signal.addEventListener('abort', onAbort, { once: true });
    });
    return await Promise.race([client.agents.me(), aborted]);
  } catch (error) {
    throw error;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

function validateNodeSpawnBaseUrl(raw: string): string {
  let url: URL;
  try { url = new URL(raw); }
  catch (error) {
    throw new NodeSpawnError('Invalid Agent Relay base URL', 'spawn_invalid_input', error);
  }
  if (url.username || url.password || url.search || url.hash || url.pathname !== '/'
    || !['https:', 'http:'].includes(url.protocol)) {
    throw new NodeSpawnError('Invalid Agent Relay base URL', 'spawn_invalid_input');
  }
  const loopback = url.hostname === '[::1]' || (isIP(url.hostname) === 4 && url.hostname.startsWith('127.'));
  if (url.protocol !== 'https:' && !loopback) {
    throw new NodeSpawnError('Agent Relay credentials require HTTPS outside literal loopback addresses', 'spawn_invalid_input');
  }
  return url.origin;
}
