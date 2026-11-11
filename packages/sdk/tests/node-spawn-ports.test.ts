import { describe, expect, it, vi } from 'vitest';
import { RelayPlacementError } from '@agent-relay/sdk/messaging';
import {
  LocalNodeSpawnPort,
  type CoreBridgeApi,
  type CoreBridgeClient,
} from '../src/node-spawn-local.js';
import { RemoteNodeSpawnPort } from '../src/node-spawn-remote.js';

interface TestCore {
  call<T = unknown>(method: string, params?: Record<string, unknown>): Promise<T>;
}

const beforeDispatch = async (): Promise<void> => undefined;

function localPort(core: TestCore): LocalNodeSpawnPort {
  const client = {
    hello: { bridge_version: 2, daemon_version: 'test', pid: 1, methods: [], topics: [] },
    close() {},
  } satisfies CoreBridgeClient;
  const bridge = {
    spawnTargets: () => core.call('spawn.targets'),
    spawnInvoke: (_client, params) => core.call('spawn.invoke', { ...params }),
    spawnStatus: (_client, params) => core.call('spawn.status', { ...params }),
    spawnRelease: (_client, params) => core.call('spawn.release', { ...params }),
  } satisfies Pick<CoreBridgeApi, 'spawnTargets' | 'spawnInvoke' | 'spawnStatus' | 'spawnRelease'>;
  return new LocalNodeSpawnPort(client, bridge, {
    harnesses: ['codex'],
    directoryScope: ['/workspace'],
  }, { id: 'node_1', name: 'desktop-1' });
}

describe('local node-spawn port', () => {
  it('uses bound bridge v2 spawn methods with no raw caller credential and exact release identity', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const dispatchOrder: string[] = [];
    const core: TestCore = {
      async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        calls.push([method, params]);
        if (method === 'spawn.invoke') dispatchOrder.push('spawn.invoke');
        if (method === 'spawn.targets') return { targets: [{ id: 'node_1', name: 'desktop-1', live: true,
          handlers_live: true, stale: false, capabilities: ['spawn:codex'], active_agents: 0,
          reserved_agents: 0, max_agents: 2 }] } as T;
        if (method === 'spawn.invoke' || (method === 'spawn.status' && params?.action === 'spawn')) return { id: 'inv_1', status: 'completed', node_id: 'node_1',
          agent_id: 'agent_1', name: 'worker_1', spawned: true, ready: true, task_unconfirmed: false } as T;
        return { id: 'rel_1', status: 'completed', name: 'worker_1', spawned: false,
          ready: false, released: true, task_unconfirmed: false } as T;
      },
    };
    const port = localPort(core);
    const receipt = await port.spawn({ name: 'worker_1', harness: 'codex', task: 'work',
      directory: '/workspace', idempotencyKey: 'dispatch_1234567890' }, async () => {
      dispatchOrder.push('dispatch.fence');
    });
    await port.release({ receipt, idempotencyKey: 'release_1234567890' });
    expect(calls[1]).toEqual(['spawn.invoke', expect.objectContaining({ node_id: 'node_1', name: 'worker_1' })]);
    expect(calls[2]).toEqual(['spawn.status', expect.objectContaining({ invocation_id: 'inv_1' })]);
    expect(calls[3]).toEqual(['spawn.release', expect.objectContaining({
      expected_agent_id: 'agent_1', node_id: 'node_1', node_name: 'desktop-1',
      name: 'worker_1', idempotency_key: 'release_1234567890' })]);
    expect(dispatchOrder).toEqual(['dispatch.fence', 'spawn.invoke']);
    for (const [, params] of calls) {
      if (params === undefined) continue;
      expect(params).not.toHaveProperty('caller_name');
      expect(params).not.toHaveProperty('caller_secret');
    }
  });

  it('refuses local-only fields the Desktop core bridge cannot preserve', async () => {
    const calls = vi.fn();
    const core: TestCore = { async call<T>(): Promise<T> { calls(); throw new Error('unused'); } };
    const port = localPort(core);
    await expect(port.spawn({ name: 'worker_1', harness: 'codex', task: 'work', directory: '/workspace',
      model: 'codex-medium', idempotencyKey: 'dispatch_1234567890' }, beforeDispatch)).rejects.toMatchObject({
      code: 'spawn_invalid_input',
    });
    expect(calls).not.toHaveBeenCalled();
  });

  it.each([
    { harness: 'claude', directory: '/workspace', label: 'harness' },
    { harness: 'codex', directory: '/other', label: 'directory' },
    { harness: 'codex', directory: '/workspace-sibling', label: 'directory prefix' },
  ])('refuses a $label outside the caller-file scope before bridge dispatch', async request => {
    const calls = vi.fn();
    const port = localPort({ async call<T>(): Promise<T> { calls(); throw new Error('unused'); } });
    await expect(port.spawn({ name: 'worker_1', harness: request.harness, task: 'work',
      directory: request.directory, idempotencyKey: 'dispatch_1234567890' }, beforeDispatch))
      .rejects.toMatchObject({ code: 'outside_scope' });
    expect(calls).not.toHaveBeenCalled();
  });

  it.each([
    { label: 'invalid input', request: { directory: undefined }, targetReadFails: false },
    { label: 'invalid scope', request: { directory: '/workspace', harness: 'claude' }, targetReadFails: false },
    { label: 'target read failure', request: { directory: '/workspace' }, targetReadFails: true },
    { label: 'target mismatch', request: { directory: '/workspace', node: 'desktop-other' }, targetReadFails: false },
  ])('does not enter the dispatch hook for $label', async testCase => {
    const entered = vi.fn(async () => undefined);
    const core: TestCore = { async call<T>(method: string): Promise<T> {
      if (method !== 'spawn.targets') throw new Error('spawn must not be invoked');
      if (testCase.targetReadFails) throw new Error('target read failed');
      return { targets: [{ id: 'node_1', name: 'desktop-1', live: true,
        handlers_live: true, stale: false, capabilities: ['spawn:codex'] }] } as T;
    } };
    await expect(localPort(core).spawn({
      name: 'worker_1', harness: testCase.request.harness ?? 'codex', task: 'work',
      idempotencyKey: 'dispatch_1234567890',
      ...(testCase.request.directory === undefined ? {} : { directory: testCase.request.directory }),
      ...(testCase.request.node === undefined ? {} : { node: testCase.request.node }),
    }, entered)).rejects.toBeInstanceOf(Error);
    expect(entered).not.toHaveBeenCalled();
  });

  it('refuses local targets without an exact string id instead of fabricating one', async () => {
    const core: TestCore = { async call<T>(): Promise<T> {
      return { targets: [{ id: undefined, name: 'desktop-1', live: true,
        handlers_live: true, capabilities: ['spawn:codex'] }] } as T;
    } };
    const port = localPort(core);
    await expect(port.targets()).rejects.toMatchObject({ code: 'invalid_core_response' });
  });

  it.each([
    { live: false, handlers_live: true },
    { live: true, handlers_live: false },
  ])('does not dispatch to an explicitly named node unless both liveness checks pass (%j)', async readiness => {
    const calls = vi.fn();
    const core: TestCore = { async call<T>(method: string): Promise<T> {
      calls(method);
      if (method === 'spawn.targets') return { targets: [{ id: 'node_1', name: 'desktop-1',
        ...readiness, stale: false, capabilities: ['spawn:codex'] }] } as T;
      throw new Error('spawn must not be invoked');
    } };
    const port = localPort(core);
    await expect(port.spawn({ name: 'worker_1', harness: 'codex', task: 'work', node: 'desktop-1',
      directory: '/workspace', idempotencyKey: 'dispatch_1234567890' }, beforeDispatch)).rejects.toMatchObject({
      code: 'no_eligible_node',
    });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('does not dispatch to a duplicate node name with a different authenticated id', async () => {
    const calls = vi.fn();
    const core: TestCore = { async call<T>(method: string): Promise<T> {
      calls(method);
      if (method === 'spawn.targets') return { targets: [{ id: 'node_other', name: 'desktop-1',
        live: true, handlers_live: true, stale: false, capabilities: ['spawn:codex'] }] } as T;
      throw new Error('spawn must not be invoked');
    } };
    await expect(localPort(core).spawn({ name: 'worker_1', harness: 'codex', task: 'work',
      node: 'desktop-1', directory: '/workspace', idempotencyKey: 'dispatch_1234567890' }, beforeDispatch))
      .rejects.toMatchObject({ code: 'no_eligible_node' });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('stops polling on a denied terminal status', async () => {
    const status = vi.fn();
    const core: TestCore = { async call<T>(method: string): Promise<T> {
      if (method === 'spawn.targets') return { targets: [{ id: 'node_1', name: 'desktop-1', live: true,
        handlers_live: true, stale: false, capabilities: ['spawn:codex'] }] } as T;
      if (method === 'spawn.invoke') return { id: 'inv_1', status: 'pending', spawned: false,
        ready: false, task_unconfirmed: false } as T;
      if (method === 'spawn.status') {
        status();
        return { id: 'inv_1', status: 'denied', spawned: false, ready: false,
          task_unconfirmed: false, error_code: 'outside_scope' } as T;
      }
      throw new Error(`unexpected core method: ${method}`);
    } };
    const port = localPort(core);
    await expect(port.spawn({ name: 'worker_1', harness: 'codex', task: 'work', directory: '/workspace',
      idempotencyKey: 'dispatch_1234567890' }, beforeDispatch)).rejects.toMatchObject({ code: 'outside_scope' });
    expect(status).toHaveBeenCalledOnce();
  });

  it('refuses a completed local spawn whose returned node identity changed', async () => {
    const core: TestCore = { async call<T>(method: string): Promise<T> {
      if (method === 'spawn.targets') return { targets: [
        { id: 'node_1', name: 'desktop-1', live: true,
          handlers_live: true, stale: false, capabilities: ['spawn:codex'] },
        { id: 'node_other', name: 'desktop-2', live: true,
          handlers_live: true, stale: false, capabilities: ['spawn:codex'] },
      ] } as T;
      if (method === 'spawn.invoke') return { id: 'inv_1', status: 'pending', spawned: false,
        ready: false, task_unconfirmed: false } as T;
      return { id: 'inv_1', status: 'completed', node_id: 'node_other', agent_id: 'agent_1',
        name: 'worker_1', spawned: true, ready: true, task_unconfirmed: false } as T;
    } };
    const port = localPort(core);
    await expect(port.spawn({ name: 'worker_1', harness: 'codex', task: 'work', directory: '/workspace',
      idempotencyKey: 'dispatch_1234567890' }, beforeDispatch)).rejects.toMatchObject({
      code: 'spawn_identity_mismatch',
      cleanup: { nodeId: 'node_other', nodeName: 'desktop-2', name: 'worker_1', agentId: 'agent_1' },
    });
  });

  it('refuses a completed local spawn without explicit task delivery confirmation', async () => {
    const core: TestCore = { async call<T>(method: string): Promise<T> {
      if (method === 'spawn.targets') return { targets: [{ id: 'node_1', name: 'desktop-1', live: true,
        handlers_live: true, stale: false, capabilities: ['spawn:codex'] }] } as T;
      if (method === 'spawn.invoke') return { id: 'inv_1', status: 'pending', spawned: false,
        ready: false, task_unconfirmed: false } as T;
      if (method === 'spawn.status') return { id: 'inv_1', status: 'completed', node_id: 'node_1',
        agent_id: 'agent_1', name: 'worker_1', spawned: true, ready: true } as T;
      throw new Error(`unexpected core method: ${method}`);
    } };
    const port = localPort(core);
    await expect(port.spawn({ name: 'worker_1', harness: 'codex', task: 'work', directory: '/workspace',
      idempotencyKey: 'dispatch_1234567890' }, beforeDispatch)).rejects.toMatchObject({
      code: 'spawn_task_unconfirmed',
      cleanup: { nodeId: 'node_1', nodeName: 'desktop-1', name: 'worker_1', agentId: 'agent_1' },
    });
  });

  it('retains exact cleanup identity when local spawn confirmation times out', async () => {
    vi.useFakeTimers();
    try {
      const status = vi.fn();
      const core: TestCore = { async call<T>(method: string): Promise<T> {
        if (method === 'spawn.targets') return { targets: [{ id: 'node_1', name: 'desktop-1', live: true,
          handlers_live: true, stale: false, capabilities: ['spawn:codex'] }] } as T;
        if (method === 'spawn.invoke') return { id: 'inv_1', status: 'pending', spawned: false,
          ready: false, task_unconfirmed: false } as T;
        if (method === 'spawn.status') {
          status();
          return { id: 'inv_1', status: 'running', node_id: 'node_1', agent_id: 'agent_1',
            name: 'worker_1', spawned: true, ready: false, task_unconfirmed: false } as T;
        }
        throw new Error(`unexpected core method: ${method}`);
      } };
      const failure = expect(localPort(core).spawn({ name: 'worker_1', harness: 'codex', task: 'work',
        directory: '/workspace', idempotencyKey: 'dispatch_1234567890', timeoutMs: 750 }, beforeDispatch))
        .rejects.toMatchObject({ code: 'spawn_unconfirmed', cleanup: {
          id: 'inv_1', nodeId: 'node_1', nodeName: 'desktop-1', name: 'worker_1', agentId: 'agent_1',
        } });
      await vi.waitFor(() => expect(status).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(1_000);
      await failure;
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains exact cleanup identity when later local spawn polling fails', async () => {
    vi.useFakeTimers();
    try {
      const pollFailure = new Error('core disconnected');
      let statusCalls = 0;
      const core: TestCore = { async call<T>(method: string): Promise<T> {
        if (method === 'spawn.targets') return { targets: [{ id: 'node_1', name: 'desktop-1', live: true,
          handlers_live: true, stale: false, capabilities: ['spawn:codex'] }] } as T;
        if (method === 'spawn.invoke') return { id: 'inv_1', status: 'pending', spawned: false,
          ready: false, task_unconfirmed: false } as T;
        if (method === 'spawn.status' && statusCalls++ === 0) return { id: 'inv_1', status: 'running',
          node_id: 'node_1', agent_id: 'agent_1', name: 'worker_1', spawned: true,
          ready: false, task_unconfirmed: false } as T;
        if (method === 'spawn.status') throw pollFailure;
        throw new Error(`unexpected core method: ${method}`);
      } };
      const failure = expect(localPort(core).spawn({ name: 'worker_1', harness: 'codex', task: 'work',
        directory: '/workspace', idempotencyKey: 'dispatch_1234567890' }, beforeDispatch))
        .rejects.toMatchObject({ code: 'spawn_unconfirmed', cause: pollFailure, cleanup: {
          id: 'inv_1', nodeId: 'node_1', nodeName: 'desktop-1', name: 'worker_1', agentId: 'agent_1',
        } });
      await vi.waitFor(() => expect(statusCalls).toBe(1));
      await vi.advanceTimersByTimeAsync(500);
      await failure;
    } finally {
      vi.useRealTimers();
    }
  });

  it('fails closed on a conflicting later spawn identity and retains the first exact cleanup', async () => {
    let statusCalls = 0;
    const core: TestCore = { async call<T>(method: string): Promise<T> {
      if (method === 'spawn.targets') return { targets: [{ id: 'node_1', name: 'desktop-1', live: true,
        handlers_live: true, stale: false, capabilities: ['spawn:codex'] }] } as T;
      if (method === 'spawn.invoke') return { id: 'inv_1', status: 'pending', spawned: false,
        ready: false, task_unconfirmed: false } as T;
      if (method === 'spawn.status' && statusCalls++ === 0) return { id: 'inv_1', status: 'running',
        node_id: 'node_1', agent_id: 'agent_1', name: 'worker_1', spawned: true,
        ready: false, task_unconfirmed: false } as T;
      if (method === 'spawn.status') return { id: 'inv_1', status: 'completed', node_id: 'node_1',
        agent_id: 'agent_other', name: 'worker_1', spawned: true,
        ready: true, task_unconfirmed: false } as T;
      throw new Error(`unexpected core method: ${method}`);
    } };
    const pending = localPort(core).spawn({ name: 'worker_1', harness: 'codex', task: 'work',
      directory: '/workspace', idempotencyKey: 'dispatch_1234567890' }, beforeDispatch);
    await expect(pending).rejects.toMatchObject({ code: 'spawn_identity_mismatch', cleanup: {
      id: 'inv_1', nodeId: 'node_1', nodeName: 'desktop-1', name: 'worker_1', agentId: 'agent_1',
    } });
  });
});

describe('remote node-spawn port', () => {
  it('confirms readiness, resolves exact identity, and targets release to the same node', async () => {
    const dispatchOrder: string[] = [];
    const placement = vi.fn()
      .mockImplementationOnce(async () => {
        dispatchOrder.push('placement.spawn');
        return { invocationId: 'ack_1', actionName: 'spawn', status: 'pending',
        node: { id: 'node_1', name: 'desktop-1', status: 'online', capabilities: [] },
        placement: { node: 'desktop-1', confirmed: true, state: 'ready' },
        confirmation: { invocationId: 'inv_1', actionName: 'spawn', status: 'completed',
          output: { spawned: true, ready: true, name: 'worker_1' } } };
      })
      .mockResolvedValueOnce({ invocationId: 'rel_1', actionName: 'release', status: 'pending',
        placement: { node: 'desktop-1', confirmed: false, state: 'accepted' } });
    const getInvocation = vi.fn().mockResolvedValue({ invocationId: 'rel_1', actionName: 'release',
      status: 'completed', output: { released: true, name: 'worker_1' } });
    const port = new RemoteNodeSpawnPort({
      agents: { get: async name => ({ id: 'agent_1', name }) },
      nodes: { list: async () => [] }, placement: { spawn: placement }, commands: { getInvocation },
    });
    const receipt = await port.spawn({ name: 'worker_1', harness: 'codex', task: 'work',
      idempotencyKey: 'dispatch_1234567890' }, async () => {
      dispatchOrder.push('dispatch.fence');
    });
    await port.release({ receipt, idempotencyKey: 'release_1234567890' });
    expect(receipt).toMatchObject({ agentId: 'agent_1', nodeName: 'desktop-1', ready: true });
    expect(placement.mock.calls[0]![0]).toMatchObject({ confirm: true, verifyReady: true,
      input: { idempotency_key: 'dispatch_1234567890' } });
    expect(placement.mock.calls[1]![0]).toMatchObject({ capability: 'release', actionName: 'release',
      node: 'desktop-1', input: { name: 'worker_1', expected_agent_id: 'agent_1',
        idempotency_key: 'release_1234567890' } });
    expect(getInvocation).toHaveBeenCalledWith('release', 'rel_1');
    expect(dispatchOrder).toEqual(['dispatch.fence', 'placement.spawn']);
  });

  it('returns exact cleanup identity when task delivery verification fails after spawn', async () => {
    const port = new RemoteNodeSpawnPort({
      agents: { get: async name => ({ id: 'agent_1', name }) },
      nodes: { list: async () => [] },
      placement: { spawn: async () => ({ invocationId: 'ack_1', actionName: 'spawn', status: 'pending',
        node: { id: 'node_1', name: 'desktop-1', status: 'online', capabilities: [] },
        placement: { node: 'desktop-1', confirmed: true, state: 'ready' },
        confirmation: { invocationId: 'inv_1', actionName: 'spawn', status: 'completed',
          output: { spawned: true, ready: true, name: 'worker_1', warning: 'spawn_task_unconfirmed' } } }) },
      commands: { getInvocation: vi.fn() },
    });
    await expect(port.spawn({ name: 'worker_1', harness: 'codex', task: 'work',
      idempotencyKey: 'dispatch_1234567890' }, beforeDispatch)).rejects.toMatchObject({
      code: 'spawn_task_unconfirmed',
      cleanup: { id: 'inv_1', nodeId: 'node_1', nodeName: 'desktop-1',
        name: 'worker_1', agentId: 'agent_1' },
    });
  });

  it('retains cleanup identity from the real SDK placement error receipt', async () => {
    const receipt = { invocationId: 'inv_1', actionName: 'spawn', status: 'completed',
      dispatchedNodeId: 'node_1', output: { spawned: true, ready: true,
        name: 'worker_1', agent_id: 'agent_1', warning: 'spawn_task_unconfirmed' } };
    const port = new RemoteNodeSpawnPort({
      agents: { get: async name => ({ id: 'agent_1', name }) },
      nodes: { list: async () => [] },
      placement: { spawn: async () => { throw new RelayPlacementError('spawn_failed', 'task unconfirmed', {
        capability: 'spawn:codex', node: 'desktop-1', attempts: 1,
        invocationId: 'inv_1', state: 'failed', dispatchState: 'dispatched', receipt,
      }); } },
      commands: { getInvocation: vi.fn() },
    });
    await expect(port.spawn({ name: 'worker_1', harness: 'codex', task: 'work',
      idempotencyKey: 'dispatch_1234567890' }, beforeDispatch)).rejects.toMatchObject({
      code: 'spawn_task_unconfirmed',
      cleanup: { id: 'inv_1', nodeId: 'node_1', nodeName: 'desktop-1',
        name: 'worker_1', agentId: 'agent_1' },
    });
  });

  it('never substitutes a conflicting roster id for the handler cleanup identity', async () => {
    const port = new RemoteNodeSpawnPort({
      agents: { get: async name => ({ id: 'agent_roster_replacement', name }) },
      nodes: { list: async () => [] },
      placement: { spawn: async () => ({ invocationId: 'ack_1', actionName: 'spawn', status: 'pending',
        node: { id: 'node_1', name: 'desktop-1', status: 'online', capabilities: [] },
        placement: { node: 'desktop-1', confirmed: true, state: 'ready' },
        confirmation: { invocationId: 'inv_1', actionName: 'spawn', status: 'completed',
          output: { spawned: true, ready: true, name: 'worker_1', agent_id: 'agent_spawned' } } }) },
      commands: { getInvocation: vi.fn() },
    });
    await expect(port.spawn({ name: 'worker_1', harness: 'codex', task: 'work',
      idempotencyKey: 'dispatch_1234567890' }, beforeDispatch)).rejects.toMatchObject({
      code: 'spawn_identity_mismatch',
      cleanup: { agentId: 'agent_spawned', name: 'worker_1', nodeName: 'desktop-1' },
    });
  });

  it('retains the handler cleanup identity when the ready-agent roster is unavailable', async () => {
    vi.useFakeTimers();
    try {
      const port = new RemoteNodeSpawnPort({
        agents: { get: async () => { throw new Error('roster unavailable'); } },
        nodes: { list: async () => [] },
        placement: { spawn: async () => ({ invocationId: 'ack_1', actionName: 'spawn', status: 'pending',
          node: { id: 'node_1', name: 'desktop-1', status: 'online', capabilities: [] },
          placement: { node: 'desktop-1', confirmed: true, state: 'ready' },
          confirmation: { invocationId: 'inv_1', actionName: 'spawn', status: 'completed',
            output: { spawned: true, ready: true, name: 'worker_1', agent_id: 'agent_spawned' } } }) },
        commands: { getInvocation: vi.fn() },
      });
      const pending = port.spawn({ name: 'worker_1', harness: 'codex', task: 'work',
        idempotencyKey: 'dispatch_1234567890' }, beforeDispatch);
      await vi.runAllTimersAsync();
      await expect(pending).rejects.toMatchObject({
        code: 'spawn_identity_unavailable',
        cleanup: { id: 'inv_1', nodeId: 'node_1', nodeName: 'desktop-1',
          name: 'worker_1', agentId: 'agent_spawned' },
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it('recovers the selected node name from its dispatch id when placement metadata lags', async () => {
    const list = vi.fn(async () => [{ id: 'node_1', name: 'desktop-1', status: 'online', capabilities: [] }]);
    const port = new RemoteNodeSpawnPort({
      agents: { get: async name => ({ id: 'agent_1', name }) },
      nodes: { list },
      placement: { spawn: async () => ({ invocationId: 'ack_1', actionName: 'spawn', status: 'pending',
        placement: { confirmed: true, state: 'ready' },
        confirmation: { invocationId: 'inv_1', actionName: 'spawn', status: 'completed',
          dispatchedNodeId: 'node_1', output: { spawned: true, ready: true, name: 'worker_1' } } }) },
      commands: { getInvocation: vi.fn() },
    });
    await expect(port.spawn({ name: 'worker_1', harness: 'codex', task: 'work',
      idempotencyKey: 'dispatch_1234567890' }, beforeDispatch)).resolves.toMatchObject({
      nodeId: 'node_1', nodeName: 'desktop-1', agentId: 'agent_1',
    });
    expect(list).toHaveBeenCalledOnce();
  });

  it('refuses an otherwise ready spawn when placement was not confirmed', async () => {
    const port = new RemoteNodeSpawnPort({
      agents: { get: async name => ({ id: 'agent_1', name }) },
      nodes: { list: async () => [] },
      placement: { spawn: async () => ({ invocationId: 'ack_1', actionName: 'spawn', status: 'pending',
        node: { id: 'node_1', name: 'desktop-1', status: 'online', capabilities: [] },
        placement: { node: 'desktop-1', confirmed: false, state: 'accepted' },
        confirmation: { invocationId: 'inv_1', actionName: 'spawn', status: 'completed',
          output: { spawned: true, ready: true, name: 'worker_1' } } }) },
      commands: { getInvocation: vi.fn() },
    });
    await expect(port.spawn({ name: 'worker_1', harness: 'codex', task: 'work',
      idempotencyKey: 'dispatch_1234567890' }, beforeDispatch)).rejects.toMatchObject({
      code: 'spawn_placement_unconfirmed',
      cleanup: expect.objectContaining({ agentId: 'agent_1', nodeName: 'desktop-1' }),
    });
  });
});
