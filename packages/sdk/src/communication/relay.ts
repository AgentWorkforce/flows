/**
 * Compatibility types for journal communication helpers. Runtime broker
 * construction was intentionally removed; no call here starts a daemon.
 */
export interface RelayMessaging {
  messages: {
    direct(input: Record<string, unknown>): Promise<unknown>;
    send(input: Record<string, unknown>): Promise<unknown>;
  };
  channels: {
    create(input: Record<string, unknown>): Promise<unknown>;
    get(name: string): Promise<unknown>;
    join(name: string): Promise<unknown>;
  };
}

export interface RelayRuntime {
  prefix: string;
  messaging: RelayMessaging;
  project(input: Record<string, unknown>): void;
  close(): Promise<void>;
}

export async function loadRelayModules(): Promise<{ RelaycastMessagingClient: unknown }> {
  try {
    const sdk = await import('@agent-relay/sdk');
    return { RelaycastMessagingClient: sdk.RelaycastMessagingClient };
  } catch (error) {
    throw new Error('Agent Relay node spawn requires optional @agent-relay/sdk >=17.2.1 <19.', { cause: error });
  }
}

export async function acquireRelayRuntime(_dataDir: string, _runId: string): Promise<RelayRuntime> {
  throw new Error('Broker-backed communication runtime was removed; native node-spawn communication is not admitted yet');
}

export async function connectLocalBroker(_cwd: string): Promise<never> {
  throw new Error('Local Relay broker connections were removed');
}
