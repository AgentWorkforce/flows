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

import { createLocalNodeSpawnRuntime, createNodeSpawnRuntime, createNodeSpawnRuntimeOwner, createRemoteNodeSpawnRuntime,
  type NodeSpawnRuntime } from '../src/node-spawn-runtime.js';
import type { CallerDescriptor, CoreBridgeApi, CoreBridgeClient } from '../src/node-spawn-local.js';
import { waitForNodeResult } from '../src/node-spawn-result.js';
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
    await vi.waitFor(() => expect(relay.me).toHaveBeenCalledOnce());
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
      idempotencyKey: 'dispatch_1234567890', attempt: 1, dataDir: '/tmp/unused',
    }, { agentToken: 'agent-token', signal: controller.signal });
    await vi.waitFor(() => expect(relay.me).toHaveBeenCalledOnce());
    controller.abort(new Error('lease lost'));
    await expect(pending).rejects.toThrow('lease lost');
    expect(relay.disconnect).toHaveBeenCalledOnce();
  });

  it('bounds a runtime provider that ignores cancellation by the task deadline', async () => {
    const runtimeProvider = vi.fn((_signal?: AbortSignal) => new Promise<NodeSpawnRuntime>(() => undefined));
    await expect(runAgentRelayTask({
      cli: 'codex', task: 'work', runId: 'run_1', stepId: 'step_1',
      idempotencyKey: 'dispatch_1234567890', attempt: 1, dataDir: '/tmp/unused', timeoutMs: 5,
    }, { runtimeProvider })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'task_timeout' }),
    });
    expect(runtimeProvider).toHaveBeenCalledOnce();
    expect(runtimeProvider.mock.calls[0]![0]?.aborted).toBe(true);
  });
});

describe('Desktop service-caller runtime', () => {
  const descriptor: CallerDescriptor = {
    schema: 'agent-relay-service-caller/2',
    schemaVersion: 2,
    auth: { type: 'challenge' },
    credential: { callerId: 'sc_0123456789abcdef' },
    callerId: 'sc_0123456789abcdef',
    callerName: 'flows-project',
    publisher: { id: 'agent_publisher', name: 'flows-project' },
    workspace: {
      site_url: 'https://agentrelay.com',
      base_url: 'https://cast.agentrelay.com',
      workspace_id: 'workspace_1',
      relaycast_workspace_id: 'relay_workspace_1',
    },
    account: { user_id: 'user_1' },
    createdAt: '2026-11-08T00:00:00.000Z',
    expiresAt: '2026-12-08T00:00:00.000Z',
    harnesses: ['codex'],
    directoryScope: ['/workspace'],
    ownsOnly: true,
    socket: '/tmp/core.sock',
    inbox: {
      transport: 'core-bridge',
      open: 'caller.inbox.open',
      next: 'caller.inbox.next',
      ack: 'caller.inbox.ack',
      fail: 'caller.inbox.fail',
      close: 'caller.inbox.close',
      disconnect: 'caller.disconnect',
    },
    desktopVersion: '18.0.0',
  };

  function fixture() {
    const clients: CoreBridgeClient[] = [];
    const close = vi.fn();
    const bridge: CoreBridgeApi = {
      connectCore: vi.fn(async () => {
        const client = { hello: { methods: [] }, close } satisfies CoreBridgeClient;
        clients.push(client);
        return client;
      }),
      readCallerDescriptor: vi.fn(async () => descriptor),
      authenticate: vi.fn(async () => ({ caller_id: descriptor.callerId })),
      requireServiceCallerMethods: vi.fn(),
      assertServiceCallerIdentity: vi.fn((caller, identity) => {
        if (caller.publisher.id !== identity.publisher.id
          || caller.publisher.name !== identity.publisher.name
          || caller.workspace.base_url !== identity.base_url
          || caller.workspace.workspace_id !== identity.workspace_id
          || caller.workspace.relaycast_workspace_id !== identity.relaycast_workspace_id) {
          throw Object.assign(new Error('identity mismatch'), { code: 'caller_identity_mismatch' });
        }
      }),
      serviceCallerIdentity: vi.fn(async () => ({
        publisher: descriptor.publisher,
        node: { id: 'node_1', name: 'desktop-1' },
        base_url: descriptor.workspace.base_url,
        workspace_id: descriptor.workspace.workspace_id,
        relaycast_workspace_id: descriptor.workspace.relaycast_workspace_id,
      })),
      spawnTargets: vi.fn(async () => ({ targets: [] })),
      spawnInvoke: vi.fn(),
      spawnStatus: vi.fn(),
      spawnRelease: vi.fn(),
      serviceCallerInboxOpen: vi.fn(async () => ({ iterator_id: 'it_1' })),
      serviceCallerInboxNext: vi.fn(async () => ({ delivery: {
        item_id: 'item_1', message_id: 'message_1', invocation_id: 'inv_1', sent_at: 'now',
        sender: { id: 'agent_1', name: 'worker_1' }, text: 'RELAYFLOWS_RESULT_V1 {}',
      } })),
      serviceCallerInboxAck: vi.fn(async () => ({})),
      serviceCallerInboxFail: vi.fn(async () => ({})),
      serviceCallerInboxClose: vi.fn(async () => ({})),
      serviceCallerDisconnect: vi.fn(async () => ({})),
    };
    return { bridge, clients, close };
  }

  it('refuses ambiguous local and remote authority before loading either runtime', async () => {
    const { bridge } = fixture();
    await expect(createNodeSpawnRuntime({
      RELAYFLOW_SERVICE_CALLER_FILE: '/tmp/caller.json',
      RELAY_AGENT_TOKEN: 'agent-token',
    }, { bridge })).rejects.toMatchObject({ code: 'ambiguous_publisher_authority' });
    expect(bridge.readCallerDescriptor).not.toHaveBeenCalled();
    expect(relay.constructorOptions).toHaveLength(0);
  });

  it('does not scan for a Desktop caller when neither authority was explicit', async () => {
    const { bridge } = fixture();
    await expect(createNodeSpawnRuntime({}, { bridge }))
      .rejects.toMatchObject({ code: 'publisher_token_required' });
    expect(bridge.readCallerDescriptor).not.toHaveBeenCalled();
    expect(bridge.connectCore).not.toHaveBeenCalled();
  });

  it('refuses a relative caller file before loading or connecting the optional bridge', async () => {
    const { bridge } = fixture();
    await expect(createLocalNodeSpawnRuntime('caller.json', { bridge }))
      .rejects.toMatchObject({ code: 'caller_file_invalid' });
    expect(bridge.readCallerDescriptor).not.toHaveBeenCalled();
    expect(bridge.connectCore).not.toHaveBeenCalled();
  });

  it('binds schema-v2 authority and checks the live identity against caller.json', async () => {
    const { bridge, close } = fixture();
    const runtime = await createLocalNodeSpawnRuntime('/tmp/caller.json', { bridge });
    expect(bridge.readCallerDescriptor).toHaveBeenCalledWith('/tmp/caller.json');
    expect(bridge.readCallerDescriptor).toHaveBeenCalledOnce();
    expect(bridge.connectCore).toHaveBeenCalledWith({ socket: '/tmp/core.sock', signal: undefined });
    expect(bridge.requireServiceCallerMethods).toHaveBeenCalledOnce();
    expect(bridge.authenticate).toHaveBeenCalledWith(expect.anything(), descriptor.credential, { signal: undefined });
    expect(runtime).toMatchObject({
      publisher: descriptor.publisher,
      baseUrl: descriptor.workspace.base_url,
      node: 'desktop-1',
    });
    await runtime.disconnect?.();
    expect(bridge.serviceCallerDisconnect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails closed when the live publisher or workspace differs from caller.json', async () => {
    const { bridge, close } = fixture();
    vi.mocked(bridge.serviceCallerIdentity).mockResolvedValue({
      publisher: { ...descriptor.publisher, id: 'agent_other' },
      node: { id: 'node_1', name: 'desktop-1' },
      base_url: descriptor.workspace.base_url,
      workspace_id: descriptor.workspace.workspace_id,
      relaycast_workspace_id: descriptor.workspace.relaycast_workspace_id,
    });
    await expect(createLocalNodeSpawnRuntime('/tmp/caller.json', { bridge }))
      .rejects.toMatchObject({ code: 'caller_identity_mismatch' });
    expect(close).toHaveBeenCalledOnce();
  });

  it('fails closed when Desktop omits the exact live node identity', async () => {
    const { bridge, close } = fixture();
    vi.mocked(bridge.serviceCallerIdentity).mockResolvedValue({
      publisher: descriptor.publisher,
      node: { id: '', name: '' },
      base_url: descriptor.workspace.base_url,
      workspace_id: descriptor.workspace.workspace_id,
      relaycast_workspace_id: descriptor.workspace.relaycast_workspace_id,
    });
    await expect(createLocalNodeSpawnRuntime('/tmp/caller.json', { bridge }))
      .rejects.toMatchObject({ code: 'caller_identity_mismatch' });
    expect(bridge.serviceCallerDisconnect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('opens the exact invocation and settles after iterator teardown on a fresh binding', async () => {
    const { bridge, clients, close } = fixture();
    const runtime = await createLocalNodeSpawnRuntime('/tmp/caller.json', { bridge });
    const iterator = runtime.inbox.inbox.subscribe({ invocationId: 'inv_1' })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({
      done: false,
      value: { id: 'item_1', message: { id: 'message_1', from: { id: 'agent_1', name: 'worker_1' } } },
    });
    await iterator.return?.();
    await runtime.inbox.inbox.ack({ inboxItemId: 'item_1', metadata: { relayflows_result: 'journaled' } });
    expect(bridge.serviceCallerInboxOpen).toHaveBeenCalledWith(clients[1], 'inv_1', { signal: undefined });
    expect(bridge.serviceCallerInboxClose).toHaveBeenCalledWith(clients[1], 'it_1');
    expect(bridge.serviceCallerInboxAck).toHaveBeenCalledWith(clients[2], 'item_1');
    expect(bridge.connectCore).toHaveBeenCalledTimes(3);
    expect(bridge.authenticate).toHaveBeenCalledTimes(3);
    expect(bridge.serviceCallerDisconnect).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    await runtime.disconnect?.();
    expect(bridge.serviceCallerDisconnect).toHaveBeenCalledTimes(3);
    expect(close).toHaveBeenCalledTimes(3);
  });

  it('does not open the fresh settlement binding until the invocation iterator is closed', async () => {
    const { bridge } = fixture();
    let finishClose!: () => void;
    vi.mocked(bridge.serviceCallerInboxClose).mockImplementation(
      () => new Promise(resolve => { finishClose = () => resolve({}); }),
    );
    const runtime = await createLocalNodeSpawnRuntime('/tmp/caller.json', { bridge });
    const delivery = await waitForNodeResult(runtime.inbox, {
      agentId: 'agent_1', agentName: 'worker_1', invocationId: 'inv_1',
      runId: 'run_1', stepId: 'step_1', dispatchId: 'dispatch_1',
    });
    await vi.waitFor(() => expect(bridge.serviceCallerInboxClose).toHaveBeenCalledOnce());
    const settlement = delivery.ack();
    expect(bridge.connectCore).toHaveBeenCalledTimes(2);
    finishClose();
    await settlement;
    expect(bridge.connectCore).toHaveBeenCalledTimes(3);
  });

  it('keeps polling the same invocation after empty long polls without opening another binding', async () => {
    const { bridge } = fixture();
    vi.mocked(bridge.serviceCallerInboxNext)
      .mockResolvedValueOnce({ delivery: null })
      .mockResolvedValueOnce({ delivery: null });
    const runtime = await createLocalNodeSpawnRuntime('/tmp/caller.json', { bridge });
    const iterator = runtime.inbox.inbox.subscribe({ invocationId: 'inv_1' })[Symbol.asyncIterator]();
    await expect(iterator.next()).resolves.toMatchObject({ done: false, value: { id: 'item_1' } });
    expect(bridge.serviceCallerInboxOpen).toHaveBeenCalledOnce();
    expect(bridge.serviceCallerInboxNext).toHaveBeenCalledTimes(3);
    await iterator.return?.();
  });

  it('disconnects a late inbox binding without opening an iterator after close', async () => {
    const { bridge, close } = fixture();
    const runtime = await createLocalNodeSpawnRuntime('/tmp/caller.json', { bridge });
    let resolveBinding!: (client: CoreBridgeClient) => void;
    vi.mocked(bridge.connectCore).mockImplementationOnce(() => new Promise(resolve => {
      resolveBinding = resolve;
    }));
    const iterator = runtime.inbox.inbox.subscribe({ invocationId: 'inv_1' })[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => expect(bridge.connectCore).toHaveBeenCalledTimes(2));
    const closing = iterator.return!();
    resolveBinding({ hello: { methods: [] }, close });
    await expect(next).resolves.toEqual({ done: true, value: undefined });
    await expect(closing).resolves.toEqual({ done: true, value: undefined });
    expect(bridge.serviceCallerInboxOpen).not.toHaveBeenCalled();
    expect(bridge.serviceCallerInboxClose).not.toHaveBeenCalled();
    expect(bridge.serviceCallerDisconnect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('closes an iterator whose uncooperative open resolves after close', async () => {
    const { bridge, close } = fixture();
    const runtime = await createLocalNodeSpawnRuntime('/tmp/caller.json', { bridge });
    let finishOpen!: () => void;
    vi.mocked(bridge.serviceCallerInboxOpen).mockImplementationOnce(
      () => new Promise(resolve => { finishOpen = () => resolve({ iterator_id: 'it_late' }); }),
    );
    const iterator = runtime.inbox.inbox.subscribe({ invocationId: 'inv_1' })[Symbol.asyncIterator]();
    const next = iterator.next();
    await vi.waitFor(() => expect(bridge.serviceCallerInboxOpen).toHaveBeenCalledOnce());
    const closing = iterator.return!();
    expect(bridge.serviceCallerInboxNext).not.toHaveBeenCalled();
    expect(bridge.serviceCallerDisconnect).not.toHaveBeenCalled();
    finishOpen();
    await expect(next).resolves.toEqual({ done: true, value: undefined });
    await expect(closing).resolves.toEqual({ done: true, value: undefined });
    expect(bridge.serviceCallerInboxNext).not.toHaveBeenCalled();
    expect(bridge.serviceCallerInboxClose).toHaveBeenCalledWith(expect.anything(), 'it_late');
    expect(bridge.serviceCallerDisconnect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it('disconnects an authenticated binding when inbox open rejects', async () => {
    const { bridge, close } = fixture();
    const runtime = await createLocalNodeSpawnRuntime('/tmp/caller.json', { bridge });
    const openFailure = new Error('open rejected');
    vi.mocked(bridge.serviceCallerInboxOpen).mockRejectedValueOnce(openFailure);
    const iterator = runtime.inbox.inbox.subscribe({ invocationId: 'inv_1' })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toBe(openFailure);
    await expect(iterator.return!()).rejects.toBe(openFailure);
    expect(bridge.serviceCallerInboxNext).not.toHaveBeenCalled();
    expect(bridge.serviceCallerInboxClose).not.toHaveBeenCalled();
    expect(bridge.serviceCallerDisconnect).toHaveBeenCalledOnce();
    expect(close).toHaveBeenCalledOnce();
  });

  it.each(['result_too_large', 'result_write_failed'] as const)(
    'preserves typed %s details with exact correlation and settles it as failed on a fresh binding',
    async code => {
      const { bridge, clients } = fixture();
      vi.mocked(bridge.serviceCallerInboxNext).mockResolvedValue({ delivery: {
        item_id: 'item_failure', message_id: 'message_failure', invocation_id: 'inv_1', sent_at: 'now',
        sender: { id: 'agent_1', name: 'worker_1' }, failure: { code, bytes: 1025, limit: 1024 },
      } });
      const runtime = await createLocalNodeSpawnRuntime('/tmp/caller.json', { bridge });
      const delivery = await waitForNodeResult(runtime.inbox, {
        agentId: 'agent_1', agentName: 'worker_1', invocationId: 'inv_1',
        runId: 'run_1', stepId: 'step_1', dispatchId: 'dispatch_1',
      });
      expect(delivery).toMatchObject({
        settlementAction: 'fail',
        envelope: {
          version: 1, run_id: 'run_1', step_id: 'step_1', dispatch_id: 'dispatch_1',
          status: 'failed', error: `${code} (bytes=1025, limit=1024)`,
        },
      });
      await delivery.ack();
      await vi.waitFor(() => expect(bridge.serviceCallerInboxClose).toHaveBeenCalledOnce());
      expect(bridge.serviceCallerInboxFail).toHaveBeenCalledWith(clients[2], 'item_failure');
      expect(bridge.connectCore).toHaveBeenCalledTimes(3);
    },
  );

  it('requires an invocation id before opening a local inbox connection', async () => {
    const { bridge } = fixture();
    const runtime = await createLocalNodeSpawnRuntime('/tmp/caller.json', { bridge });
    expect(() => runtime.inbox.inbox.subscribe({})).toThrow(
      expect.objectContaining({ code: 'result_identity_missing' }),
    );
    expect(bridge.connectCore).toHaveBeenCalledOnce();
  });

  it('refuses a delivery outside the exact opened invocation', async () => {
    const { bridge } = fixture();
    vi.mocked(bridge.serviceCallerInboxNext).mockResolvedValue({ delivery: {
      item_id: 'item_1', message_id: 'message_1', invocation_id: 'inv_other', sent_at: 'now',
      sender: { id: 'agent_1', name: 'worker_1' }, text: 'RELAYFLOWS_RESULT_V1 {}',
    } });
    const runtime = await createLocalNodeSpawnRuntime('/tmp/caller.json', { bridge });
    const iterator = runtime.inbox.inbox.subscribe({ invocationId: 'inv_1' })[Symbol.asyncIterator]();
    await expect(iterator.next()).rejects.toMatchObject({ code: 'result_identity_mismatch' });
    await iterator.return?.();
    expect(bridge.serviceCallerInboxClose).toHaveBeenCalledOnce();
  });
});
