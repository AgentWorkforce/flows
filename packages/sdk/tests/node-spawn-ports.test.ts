import { describe, expect, it, vi } from 'vitest';
import { LocalNodeSpawnPort, type CoreClient } from '../src/node-spawn-local.js';
import { RemoteNodeSpawnPort } from '../src/node-spawn-remote.js';

describe('local node-spawn port', () => {
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
    const receipt = await port.spawn({ name: 'worker_1', harness: 'codex', task: 'work',
      directory: '/workspace', idempotencyKey: 'dispatch_1234567890' });
    await port.release({ receipt, idempotencyKey: 'release_1234567890' });
    expect(calls[1]).toEqual(['spawn.invoke', expect.objectContaining({ caller_name: 'authorized-caller',
      caller_secret: 'desktop-service-secret', node_id: 'node_1', name: 'worker_1' })]);
    expect(calls[2]).toEqual(['spawn.status', expect.objectContaining({ caller_name: 'authorized-caller',
      caller_secret: 'desktop-service-secret', invocation_id: 'inv_1' })]);
    expect(calls[3]).toEqual(['spawn.release', expect.objectContaining({
      expected_agent_id: 'agent_1', caller_name: 'authorized-caller',
      caller_secret: 'desktop-service-secret' })]);
  });

  it('refuses a local service caller without its Desktop-issued secret', () => {
    const core: CoreClient = { close() {}, async call<T>(): Promise<T> { throw new Error('unused'); } };
    expect(() => new LocalNodeSpawnPort(core, { name: 'authorized-caller', secret: ' ' }))
      .toThrow(expect.objectContaining({ code: 'caller_required' }));
  });

  it('does not dispatch to an explicitly named node that is not live and handler-ready', async () => {
    const calls = vi.fn();
    const core: CoreClient = { close() {}, async call<T>(method: string): Promise<T> {
      calls(method);
      if (method === 'spawn.targets') return { targets: [{ id: 'node_1', name: 'desktop-1', live: false,
        handlers_live: true, stale: false, capabilities: ['spawn:codex'] }] } as T;
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
    expect(placement.mock.calls[1]![0]).toMatchObject({ capability: 'release', actionName: 'release',
      node: 'desktop-1', input: { name: 'worker_1', expected_agent_id: 'agent_1' } });
    expect(getInvocation).toHaveBeenCalledWith('release', 'rel_1');
  });
});
