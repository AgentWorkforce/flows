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

import { createNodeSpawnRuntimeOwner, createRemoteNodeSpawnRuntime,
  type NodeSpawnRuntime } from '../src/node-spawn-runtime.js';
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
    const runtime = await createRemoteNodeSpawnRuntime({
      RELAY_AGENT_TOKEN: 'agent-token',
      RELAY_BASE_URL: 'http://127.0.0.1:8787',
    });
    expect(runtime).toMatchObject({
      baseUrl: 'http://127.0.0.1:8787',
      publisher: { id: 'publisher_1', name: 'publisher' },
    });
    expect(relay.constructorOptions).toEqual([{
      agentToken: 'agent-token',
      baseUrl: 'http://127.0.0.1:8787',
    }]);
    await runtime.disconnect?.();
    expect(relay.disconnect).toHaveBeenCalledOnce();
  });

  it('shares one publisher runtime across concurrent tasks and closes it only with its owner', async () => {
    let resolve!: (runtime: NodeSpawnRuntime) => void;
    const disconnect = vi.fn(async () => { throw new Error('disconnect failed'); });
    const runtime = { port: {} as NodeSpawnRuntime['port'], inbox: {} as NodeSpawnRuntime['inbox'],
      publisher: { id: 'publisher_1', name: 'publisher' }, baseUrl: 'https://cast.agentrelay.com',
      disconnect } satisfies NodeSpawnRuntime;
    const factory = vi.fn((_signal: AbortSignal) => new Promise<NodeSpawnRuntime>(done => { resolve = done; }));
    const owner = createNodeSpawnRuntimeOwner(undefined, factory);
    const cancelled = new AbortController();
    const first = owner.get(cancelled.signal);
    const second = owner.get();
    cancelled.abort(new Error('first task lost its lease'));
    await expect(first).rejects.toThrow('first task lost its lease');
    expect(factory).toHaveBeenCalledOnce();
    expect(factory.mock.calls[0]![0].aborted).toBe(false);
    resolve(runtime);
    await expect(second).resolves.toBe(runtime);
    await expect(owner.get()).resolves.toBe(runtime);
    expect(disconnect).not.toHaveBeenCalled();
    await expect(owner.close()).resolves.toBeUndefined();
    expect(disconnect).toHaveBeenCalledOnce();
  });

  it('shares one pending close across concurrent owner shutdown callers', async () => {
    let releaseDisconnect!: () => void;
    const disconnect = vi.fn(() => new Promise<void>(resolve => { releaseDisconnect = resolve; }));
    const runtime = { port: {} as NodeSpawnRuntime['port'], inbox: {} as NodeSpawnRuntime['inbox'],
      publisher: { id: 'publisher_1', name: 'publisher' }, baseUrl: 'https://cast.agentrelay.com',
      disconnect } satisfies NodeSpawnRuntime;
    const owner = createNodeSpawnRuntimeOwner(undefined, async () => runtime);
    await expect(owner.get()).resolves.toBe(runtime);

    let firstSettled = false;
    let secondSettled = false;
    const first = owner.close();
    const second = owner.close();
    void first.finally(() => { firstSettled = true; });
    void second.finally(() => { secondSettled = true; });

    expect(first).toBe(second);
    await vi.waitFor(() => expect(disconnect).toHaveBeenCalledOnce());
    expect(firstSettled).toBe(false);
    expect(secondSettled).toBe(false);

    releaseDisconnect();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
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
