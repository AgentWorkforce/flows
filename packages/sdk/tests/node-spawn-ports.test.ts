import { describe, expect, it, vi } from 'vitest';
import { connectCore, LocalNodeSpawnPort, type CoreClient } from '../src/node-spawn-local.js';
import { RemoteNodeSpawnPort } from '../src/node-spawn-remote.js';

describe('local node-spawn port', () => {
  it('refuses Windows before opening an unauthenticated named pipe', async () => {
    const platform = vi.spyOn(process, 'platform', 'get').mockReturnValue('win32');
    try {
      await expect(connectCore()).rejects.toMatchObject({ code: 'untrusted_core_socket' });
    } finally {
      platform.mockRestore();
    }
  });

  it('uses the bridge v2 spawn methods and exact release identity', async () => {
    const calls: Array<[string, Record<string, unknown> | undefined]> = [];
    const core: CoreClient = {
      close() {},
      async call<T>(method: string, params?: Record<string, unknown>): Promise<T> {
        calls.push([method, params]);
        if (method === 'spawn.targets') return { targets: [{ id: 'node_1', name: 'desktop-1', live: true,
          handlers_live: true, stale: false, capabilities: ['spawn:codex'], active_agents: 0,
          reserved_agents: 0, max_agents: 2 }] } as T;
        if (method === 'spawn.invoke' || (method === 'spawn.status' && params?.action === 'spawn')) return { id: 'inv_1', status: 'completed', node_id: 'node_1',
          agent_id: 'agent_1', name: 'worker_1', spawned: true, ready: true, task_unconfirmed: false } as T;
        return { id: 'rel_1', status: 'completed', name: 'worker_1', spawned: false,
          ready: false, released: true, task_unconfirmed: false } as T;
      },
    };
    const port = new LocalNodeSpawnPort(core, {
      name: 'authorized-caller',
      secret: 'desktop-service-secret',
    });
    expect(JSON.stringify(port)).not.toContain('desktop-service-secret');
    expect(Object.values(port)).not.toContain('desktop-service-secret');
    const receipt = await port.spawn({ name: 'worker_1', harness: 'codex', task: 'work',
      directory: '/workspace', idempotencyKey: 'dispatch_1234567890' });
    await port.release({ receipt, idempotencyKey: 'release_1234567890' });
    expect(calls[1]).toEqual(['spawn.invoke', expect.objectContaining({ caller_name: 'authorized-caller',
      caller_secret: 'desktop-service-secret', node_id: 'node_1', name: 'worker_1' })]);
    expect(calls[2]).toEqual(['spawn.status', expect.objectContaining({ caller_name: 'authorized-caller',
      caller_secret: 'desktop-service-secret', invocation_id: 'inv_1' })]);
    expect(calls[3]).toEqual(['spawn.release', expect.objectContaining({
      expected_agent_id: 'agent_1', caller_name: 'authorized-caller',
      caller_secret: 'desktop-service-secret', node_id: 'node_1', node_name: 'desktop-1',
      name: 'worker_1', idempotency_key: 'release_1234567890' })]);
  });

  it('refuses a local service caller without its Desktop-issued secret', () => {
    const core: CoreClient = { close() {}, async call<T>(): Promise<T> { throw new Error('unused'); } };
    expect(() => new LocalNodeSpawnPort(core, { name: 'authorized-caller', secret: ' ' }))
      .toThrow(expect.objectContaining({ code: 'caller_required' }));
  });

  it('refuses local-only fields the Desktop core bridge cannot preserve', async () => {
    const calls = vi.fn();
    const core: CoreClient = { close() {}, async call<T>(): Promise<T> { calls(); throw new Error('unused'); } };
    const port = new LocalNodeSpawnPort(core, { name: 'authorized-caller', secret: 'desktop-service-secret' });
    await expect(port.spawn({ name: 'worker_1', harness: 'codex', task: 'work', directory: '/workspace',
      model: 'codex-medium', idempotencyKey: 'dispatch_1234567890' })).rejects.toMatchObject({
      code: 'spawn_invalid_input',
    });
    expect(calls).not.toHaveBeenCalled();
  });

  it('refuses local targets without an exact string id instead of fabricating one', async () => {
    const core: CoreClient = { close() {}, async call<T>(): Promise<T> {
      return { targets: [{ id: undefined, name: 'desktop-1', live: true,
        handlers_live: true, capabilities: ['spawn:codex'] }] } as T;
    } };
    const port = new LocalNodeSpawnPort(core, { name: 'authorized-caller', secret: 'desktop-service-secret' });
    await expect(port.targets()).rejects.toMatchObject({ code: 'invalid_core_response' });
  });

  it.each([
    { live: false, handlers_live: true },
    { live: true, handlers_live: false },
  ])('does not dispatch to an explicitly named node unless both liveness checks pass (%j)', async readiness => {
    const calls = vi.fn();
    const core: CoreClient = { close() {}, async call<T>(method: string): Promise<T> {
      calls(method);
      if (method === 'spawn.targets') return { targets: [{ id: 'node_1', name: 'desktop-1',
        ...readiness, stale: false, capabilities: ['spawn:codex'] }] } as T;
      throw new Error('spawn must not be invoked');
    } };
    const port = new LocalNodeSpawnPort(core, {
      name: 'authorized-caller',
      secret: 'desktop-service-secret',
    });
    await expect(port.spawn({ name: 'worker_1', harness: 'codex', task: 'work', node: 'desktop-1',
      directory: '/workspace', idempotencyKey: 'dispatch_1234567890' })).rejects.toMatchObject({
      code: 'no_eligible_node',
    });
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it('stops polling on a denied terminal status', async () => {
    const status = vi.fn();
    const core: CoreClient = { close() {}, async call<T>(method: string): Promise<T> {
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
    const port = new LocalNodeSpawnPort(core, { name: 'authorized-caller', secret: 'desktop-service-secret' });
    await expect(port.spawn({ name: 'worker_1', harness: 'codex', task: 'work', directory: '/workspace',
      idempotencyKey: 'dispatch_1234567890' })).rejects.toMatchObject({ code: 'outside_scope' });
    expect(status).toHaveBeenCalledOnce();
  });

  it('refuses a completed local spawn whose returned node identity changed', async () => {
    const core: CoreClient = { close() {}, async call<T>(method: string): Promise<T> {
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
    const port = new LocalNodeSpawnPort(core, { name: 'authorized-caller', secret: 'desktop-service-secret' });
    await expect(port.spawn({ name: 'worker_1', harness: 'codex', task: 'work', directory: '/workspace',
      idempotencyKey: 'dispatch_1234567890' })).rejects.toMatchObject({
      code: 'spawn_identity_mismatch',
      cleanup: { nodeId: 'node_other', nodeName: 'desktop-2', name: 'worker_1', agentId: 'agent_1' },
    });
  });

  it('refuses a completed local spawn without explicit task delivery confirmation', async () => {
    const core: CoreClient = { close() {}, async call<T>(method: string): Promise<T> {
      if (method === 'spawn.targets') return { targets: [{ id: 'node_1', name: 'desktop-1', live: true,
        handlers_live: true, stale: false, capabilities: ['spawn:codex'] }] } as T;
      if (method === 'spawn.invoke') return { id: 'inv_1', status: 'pending', spawned: false,
        ready: false, task_unconfirmed: false } as T;
      if (method === 'spawn.status') return { id: 'inv_1', status: 'completed', node_id: 'node_1',
        agent_id: 'agent_1', name: 'worker_1', spawned: true, ready: true } as T;
      throw new Error(`unexpected core method: ${method}`);
    } };
    const port = new LocalNodeSpawnPort(core, { name: 'authorized-caller', secret: 'desktop-service-secret' });
    await expect(port.spawn({ name: 'worker_1', harness: 'codex', task: 'work', directory: '/workspace',
      idempotencyKey: 'dispatch_1234567890' })).rejects.toMatchObject({
      code: 'spawn_task_unconfirmed',
      cleanup: { nodeId: 'node_1', nodeName: 'desktop-1', name: 'worker_1', agentId: 'agent_1' },
    });
  });
});

describe('remote node-spawn port', () => {
  it('confirms readiness, resolves exact identity, and targets release to the same node', async () => {
    const placement = vi.fn()
      .mockResolvedValueOnce({ invocationId: 'ack_1', actionName: 'spawn', status: 'pending',
        node: { id: 'node_1', name: 'desktop-1', status: 'online', capabilities: [] },
        placement: { node: 'desktop-1', confirmed: true, state: 'ready' },
        confirmation: { invocationId: 'inv_1', actionName: 'spawn', status: 'completed',
          output: { spawned: true, ready: true, name: 'worker_1' } } })
      .mockResolvedValueOnce({ invocationId: 'rel_1', actionName: 'release', status: 'pending',
        placement: { node: 'desktop-1', confirmed: false, state: 'accepted' } });
    const getInvocation = vi.fn().mockResolvedValue({ invocationId: 'rel_1', actionName: 'release',
      status: 'completed', output: { released: true, name: 'worker_1' } });
    const port = new RemoteNodeSpawnPort({
      agents: { get: async name => ({ id: 'agent_1', name }) },
      nodes: { list: async () => [] }, placement: { spawn: placement }, commands: { getInvocation },
    });
    const receipt = await port.spawn({ name: 'worker_1', harness: 'codex', task: 'work',
      idempotencyKey: 'dispatch_1234567890' });
    await port.release({ receipt, idempotencyKey: 'release_1234567890' });
    expect(receipt).toMatchObject({ agentId: 'agent_1', nodeName: 'desktop-1', ready: true });
    expect(placement.mock.calls[0]![0]).toMatchObject({ confirm: true, verifyReady: true,
      input: { idempotency_key: 'dispatch_1234567890' } });
    expect(placement.mock.calls[1]![0]).toMatchObject({ capability: 'release', actionName: 'release',
      node: 'desktop-1', input: { name: 'worker_1', expected_agent_id: 'agent_1',
        idempotency_key: 'release_1234567890' } });
    expect(getInvocation).toHaveBeenCalledWith('release', 'rel_1');
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
      idempotencyKey: 'dispatch_1234567890' })).rejects.toMatchObject({
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
      idempotencyKey: 'dispatch_1234567890' })).rejects.toMatchObject({
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
        idempotencyKey: 'dispatch_1234567890' });
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
      idempotencyKey: 'dispatch_1234567890' })).resolves.toMatchObject({
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
      idempotencyKey: 'dispatch_1234567890' })).rejects.toMatchObject({
      code: 'spawn_placement_unconfirmed',
      cleanup: expect.objectContaining({ agentId: 'agent_1', nodeName: 'desktop-1' }),
    });
  });
});
