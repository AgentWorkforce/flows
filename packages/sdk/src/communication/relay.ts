import { randomUUID, createHash } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

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
  HarnessDriverClient: { spawn(options: Record<string, unknown>): Promise<RelayBroker> };
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
  const key = env.RELAY_API_KEY?.trim();
  if (!key?.startsWith('rk_live_')) throw new Error('Agent communication requires RELAY_API_KEY for an existing workspace.');
  return key;
}
export interface RelayRuntime {
  broker: RelayBroker;
  messaging: RelayMessaging;
  prefix: string;
  channel: string;
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
  const workspaceKey = relayWorkspaceKey();
  const { HarnessDriverClient, RelaycastMessagingClient } = await loadRelayModules();
  const hash = createHash('sha256').update(runId).digest('hex').slice(0, 12);
  const prefix = `flow-${hash}-${randomUUID().slice(0, 8)}`;
  const channel = `wf-${runId.toLowerCase()}`;
  const options = { workspaceKey, ...(process.env.RELAY_BASE_URL ? { baseUrl: process.env.RELAY_BASE_URL } : {}) };
  const workspace = new RelaycastMessagingClient(options);
  const publisher = `${prefix}-journal`;
  const registration = await workspace.agents.register({ name: publisher, type: 'agent' });
  let broker: RelayBroker | undefined;
  try {
    const messaging = new RelaycastMessagingClient({ ...options, agentToken: registration.token });
    try { await messaging.channels.create({ name: channel }); }
    catch (error) {
      // Only an existing channel justifies recovering a failed create.
      // A failed get or join is still fatal; no projection is silently dropped.
      await messaging.channels.get(channel);
      await messaging.channels.join(channel);
    }
    const cwd = join(dataDir, 'communication', prefix);
    await mkdir(cwd, { recursive: true, mode: 0o700 });
    broker = await HarnessDriverClient.spawn({ workspaceKey, brokerName: prefix, cwd, channels: [],
      ...(process.env.RELAYFLOW_RELAY_BROKER_BIN ? { binaryPath: process.env.RELAYFLOW_RELAY_BROKER_BIN } : {}),
      env: { ...process.env, RELAY_API_KEY: workspaceKey, RELAY_WORKSPACE_KEY: workspaceKey } });
    return { broker, messaging, prefix, channel, close: async () => {
      try { await broker!.shutdown(); } finally { await workspace.agents.delete(publisher); }
    } };
  } catch (error) {
    try { await broker?.shutdown(); } finally { await workspace.agents.delete(publisher); }
    throw error;
  }
}
