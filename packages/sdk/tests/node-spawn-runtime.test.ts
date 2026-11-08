import { beforeEach, describe, expect, it, vi } from 'vitest';

const relay = vi.hoisted(() => ({
  constructorOptions: [] as Array<Record<string, unknown>>,
  disconnect: vi.fn(async () => {}),
  me: vi.fn<() => Promise<{ id: string; name: string }>>(),
}));

vi.mock('@agent-relay/sdk', () => ({
  RelaycastMessagingClient: class {
    readonly agents = { me: relay.me, get: vi.fn() };
    readonly commands = { getInvocation: vi.fn() };
    readonly events = { disconnect: relay.disconnect };
    readonly inbox = { subscribe: vi.fn(), ack: vi.fn(), fail: vi.fn() };
    readonly nodes = { list: vi.fn() };
    readonly placement = { spawn: vi.fn() };

    constructor(options: Record<string, unknown>) {
      relay.constructorOptions.push(options);
    }
  },
}));

import { createRemoteNodeSpawnRuntime } from '../src/node-spawn-runtime.js';
import { runAgentRelayTask } from '../src/agent-relay-transport.js';

describe('remote node-spawn runtime', () => {
  beforeEach(() => {
    relay.constructorOptions.length = 0;
    relay.disconnect.mockClear();
    relay.me.mockReset();
  });

  it('rejects a non-HTTPS credential origin before constructing a Relay client', async () => {
    await expect(createRemoteNodeSpawnRuntime({
      RELAY_AGENT_TOKEN: 'agent-token',
      RELAY_BASE_URL: 'http://relay.example',
    })).rejects.toMatchObject({ code: 'spawn_invalid_input' });
    expect(relay.constructorOptions).toHaveLength(0);
  });

  it('allows a literal loopback HTTP credential origin', async () => {
    relay.me.mockResolvedValue({ id: 'publisher_1', name: 'publisher' });
    await expect(createRemoteNodeSpawnRuntime({
      RELAY_AGENT_TOKEN: 'agent-token',
      RELAY_BASE_URL: 'http://127.0.0.1:8787',
    })).resolves.toMatchObject({
      baseUrl: 'http://127.0.0.1:8787',
      publisher: { id: 'publisher_1', name: 'publisher' },
    });
    expect(relay.constructorOptions).toEqual([{
      agentToken: 'agent-token',
      baseUrl: 'http://127.0.0.1:8787',
    }]);
  });

  it('honors cancellation during publisher discovery and cleans up the client', async () => {
    relay.me.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = createRemoteNodeSpawnRuntime({ RELAY_AGENT_TOKEN: 'agent-token' }, {
      signal: controller.signal,
    });
    controller.abort(new Error('lease lost'));
    await expect(pending).rejects.toThrow('lease lost');
    expect(relay.disconnect).toHaveBeenCalledOnce();
  });

  it('bounds publisher discovery and cleans up the client on timeout', async () => {
    relay.me.mockImplementation(() => new Promise(() => {}));
    const pending = createRemoteNodeSpawnRuntime({ RELAY_AGENT_TOKEN: 'agent-token' });
    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(relay.disconnect).toHaveBeenCalledOnce();
  }, 20_000);

  it('forwards the worker lease cancellation into publisher discovery', async () => {
    relay.me.mockImplementation(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = runAgentRelayTask({
      cli: 'codex', task: 'work', runId: 'run_1', stepId: 'step_1',
      idempotencyKey: 'dispatch_1234567890', dataDir: '/tmp/unused',
    }, { agentToken: 'agent-token', signal: controller.signal });
    controller.abort(new Error('lease lost'));
    await expect(pending).rejects.toThrow('lease lost');
    expect(relay.disconnect).toHaveBeenCalledOnce();
  });
});
