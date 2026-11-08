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
}

interface RelayRuntimeClient extends RemoteNodeSpawnClient, NodeResultInboxClient {
  agents: RemoteNodeSpawnClient['agents'] & { me(): Promise<NodeSpawnPublisher> };
}

export async function createRemoteNodeSpawnRuntime(env: NodeJS.ProcessEnv = process.env): Promise<NodeSpawnRuntime> {
  const agentToken = env.RELAY_AGENT_TOKEN?.trim();
  if (!agentToken) throw new NodeSpawnError(
    'Node-spawn transport requires a dedicated publisher RELAY_AGENT_TOKEN.', 'publisher_token_required');
  const baseUrl = validateBaseUrl(env.RELAY_BASE_URL?.trim() || 'https://cast.agentrelay.com');
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
  const publisher = await client.agents.me();
  if (!publisher.id?.trim() || !publisher.name?.trim()) {
    throw new NodeSpawnError('The node-spawn publisher token has no exact Relay identity', 'publisher_identity_missing');
  }
  return {
    port: new RemoteNodeSpawnPort(client),
    inbox: client,
    publisher,
    baseUrl,
    ...(env.RELAYFLOW_NODE_NAME?.trim() ? { node: env.RELAYFLOW_NODE_NAME.trim() } : {}),
    ...(env.RELAYFLOW_NODE_REPO?.trim() ? { repo: env.RELAYFLOW_NODE_REPO.trim() } : {}),
    ...(sandbox === '1' ? { sandboxOnly: true } : {}),
  };
}

function validateBaseUrl(raw: string): string {
  const url = new URL(raw);
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
