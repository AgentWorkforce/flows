import { randomUUID, createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { createProjection } from './projection.js';
import { brokerEnvironment } from './environment.js';
import { relayCredential, runTokenAgents, runTokenProvider } from './run-token.js';
import { AgentTokenSession, rotatingMessaging } from './agent-token.js';

export interface RelayEvent { kind: string; name?: string; event_id?: string; delivery_id?: string; verification?: string; [key: string]: unknown }
export interface RelayHandle {
  name: string;
  generation?: string;
  waitForReady(timeout?: number): Promise<{ reason: string }>;
  release(reason?: string, options?: { deleteIdentity?: boolean }): Promise<unknown>;
}
export interface RelayBroker {
  spawnPty(input: Record<string, unknown>): Promise<RelayHandle>;
  onEvent(callback: (event: RelayEvent) => void): () => void;
  shutdown(): Promise<void>;
}
export interface RelayMessaging {
  agents: { register(input: { name: string; type: string }): Promise<{ token: string }>; delete(name: string): Promise<void> };
  channels: { create(input: { name: string }): Promise<unknown>; get(name: string): Promise<unknown>; join(name: string): Promise<void> };
  messages: {
    direct(input: { to: string; text: string; idempotencyKey: string; metadata: Record<string, unknown>; mode: 'wait' }): Promise<{ id: string }>;
    send(input: { channel: string; text: string; idempotencyKey: string; metadata: Record<string, unknown> }): Promise<unknown>;
  };
}
interface RelayModules {
  HarnessDriverClient: { spawn(options: Record<string, unknown>): Promise<RelayBroker>;
    connect(options: { cwd: string }): LocalBroker };
  RelaycastMessagingClient: new (options: Record<string, unknown>) => RelayMessaging;
}
export async function loadRelayModules(): Promise<RelayModules> {
  // Variable imports keep optional packages out of ordinary execution and bundles.
  const driver = '@agent-relay/harness-driver';
  const sdk = '@agent-relay/sdk';
  try {
    const [harness, messaging] = await Promise.all([import(driver), import(sdk)]);
    return { HarnessDriverClient: harness.HarnessDriverClient, RelaycastMessagingClient: messaging.RelaycastMessagingClient };
  } catch {
    throw new Error('Agent communication requires optional @agent-relay/harness-driver and @agent-relay/sdk packages (>=12.3.1).');
  }
}
export function relayWorkspaceKey(env = process.env): string {
  const credential = relayCredential({ RELAY_API_KEY: env.RELAY_API_KEY });
  if (credential.kind !== 'workspace-key') throw new Error('Agent communication requires RELAY_API_KEY for an existing workspace.');
  return credential.workspaceKey;
}
export interface RelayRuntime {
  broker: RelayBroker;
  messaging: RelayMessaging;
  prefix: string;
  channel: string;
  project: ReturnType<typeof createProjection>;
  close(): Promise<void>;
}
const runtimes = new Map<string, { references: number; runtime: Promise<RelayRuntime> }>();
export async function acquireRelayRuntime(dataDir: string, runId: string): Promise<RelayRuntime> {
  const key = `${dataDir}\0${runId}`;
  let entry = runtimes.get(key);
  if (!entry) {
    entry = { references: 0, runtime: createRuntime(dataDir, runId) };
    runtimes.set(key, entry);
  }
  entry.references++;
  try {
    const runtime = await entry.runtime;
    let closed = false;
    return { ...runtime, close: async () => {
      if (closed) return;
      closed = true;
      if (--entry!.references === 0) { runtimes.delete(key); await runtime.close(); }
    } };
  } catch (error) {
    if (--entry.references === 0) runtimes.delete(key);
    throw error;
  }
}
async function createRuntime(dataDir: string, runId: string): Promise<RelayRuntime> {
  const credential = relayCredential();
  const { HarnessDriverClient, RelaycastMessagingClient } = await loadRelayModules();
  const hash = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  const prefix = `flow-${hash}-${randomUUID().slice(0, 8)}`;
  const channel = `wf-${runId.toLowerCase()}`;
  const baseUrl = process.env.RELAY_BASE_URL ? { baseUrl: process.env.RELAY_BASE_URL } : {};
  // Run-token mode: agent admin re-reads the file per request, the broker gets
  // only the file path, and no workspace key exists anywhere in this process.
  const workspace = credential.kind === 'run-token'
    ? runTokenAgents(runTokenProvider(credential.file), baseUrl)
    : new RelaycastMessagingClient({ workspaceKey: credential.workspaceKey, ...baseUrl }).agents;
  const brokerCredential = credential.kind === 'run-token'
    ? { runTokenFile: credential.file } : { workspaceKey: credential.workspaceKey };
  const publisher = `${prefix}-journal`;
  const registration = await workspace.register({ name: publisher, type: 'agent' });
  let broker: RelayBroker | undefined;
  // Run-token mode: the journal agent's at_live_ expires (relaycast#550), so it
  // is rotated in memory and the messaging client follows the current token.
  const session = credential.kind === 'run-token' ? new AgentTokenSession(publisher, registration, baseUrl) : undefined;
  const release = async () => { session?.stop(); await workspace.delete(publisher); };
  try {
    session?.start();
    const messaging = credential.kind === 'workspace-key'
      ? new RelaycastMessagingClient({ workspaceKey: credential.workspaceKey, ...baseUrl, agentToken: registration.token })
      : rotatingMessaging(session!, agentToken => new RelaycastMessagingClient({ ...baseUrl, agentToken }));
    const cwd = join(dataDir, 'communication', prefix);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    broker = await HarnessDriverClient.spawn({ ...brokerCredential, brokerName: prefix, cwd, channels: [],
      ...(process.env.RELAYFLOW_RELAY_BROKER_BIN ? { binaryPath: process.env.RELAYFLOW_RELAY_BROKER_BIN } : {}),
      env: brokerEnvironment(process.env) });
    return { broker, messaging, prefix, channel, project: createProjection(messaging, channel, runId), close: async () => {
      try { await broker!.shutdown(); } finally { await release(); }
    } };
  } catch (error) {
    try { await broker?.shutdown(); } finally { await release(); }
    throw error;
  }
}

/** Connected clients disconnect on shutdown; they never terminate the user's broker. */
export interface LocalBroker extends RelayBroker {
  connectEvents(): void;
  sendMessage(input: { to: string; text: string; from: string; mode: 'wait'; data: Record<string, unknown> }): Promise<{ event_id: string; targets: string[] }>;
}
export async function connectLocalBroker(cwd: string): Promise<LocalBroker> {
  const { HarnessDriverClient } = await loadRelayModules();
  return HarnessDriverClient.connect({ cwd });
}
