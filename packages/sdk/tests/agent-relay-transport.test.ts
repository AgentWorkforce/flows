import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentRelayTransportError, runAgentRelayTask,
  type AgentRelayTaskRequest } from '../src/agent-relay-transport.js';
import { NODE_RESULT_PREFIX } from '../src/node-spawn-result.js';
import type { NodeSpawnRuntime } from '../src/node-spawn-runtime.js';
import { NodeSpawnError, type NodeSpawnPort, type NodeSpawnReceipt } from '../src/node-spawn.js';
import { EventEmitter } from 'node:events';
import { AgentWorker } from '../src/worker.js';
import type { JournalClient } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';

const request = (dataDir: string): AgentRelayTaskRequest => ({
  cli: 'codex', task: 'Implement the change', runId: 'run_1', stepId: 'edit',
  idempotencyKey: 'dispatch_1234567890', dataDir, timeoutMs: 10_000,
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function dataDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), label));
  roots.push(directory);
  return directory;
}

function fixture(result: 'completed' | 'failed' = 'completed'): { runtime: NodeSpawnRuntime; spawn: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>; ack: ReturnType<typeof vi.fn> } {
  const receipt: NodeSpawnReceipt = {
    id: 'inv_spawn_1', action: 'spawn', status: 'completed', nodeId: 'node_1', nodeName: 'desktop-1',
    name: 'placeholder', agentId: 'agent_1', spawned: true, ready: true,
  };
  const spawn = vi.fn(async (input: { name: string }) => ({ ...receipt, name: input.name }));
  const release = vi.fn(async () => ({ id: 'inv_release_1', action: 'release' as const,
    status: 'completed' as const, spawned: false, ready: false, released: true }));
  const status = vi.fn(async () => ({ ...receipt, name: receipt.name }));
  const ack = vi.fn(async () => ({}));
  const port: NodeSpawnPort = {
    targets: async () => [], spawn, status, release,
  };
  const runtime: NodeSpawnRuntime = {
    port,
    publisher: { id: 'publisher_1', name: 'flows-publisher' },
    baseUrl: 'https://cast.agentrelay.com',
    inbox: { inbox: {
      subscribe: async function* () {
        const name = spawn.mock.results[0]?.value === undefined
          ? receipt.name : (await spawn.mock.results[0]!.value).name;
        yield {
          id: 'delivery_1',
          message: {
            id: 'message_1',
            from: { id: 'agent_1', name },
            text: NODE_RESULT_PREFIX + JSON.stringify({
              version: 1, run_id: 'run_1', step_id: 'edit', dispatch_id: 'dispatch_1234567890',
              status: result,
              ...(result === 'completed' ? { output: { summary: 'done' } } : { error: 'agent reported failure' }),
              accounting: { tokens_input: 10, tokens_output: 5 },
            }),
          },
        };
      },
      ack,
      fail: vi.fn(async () => ({})),
    } },
  };
  return { runtime, spawn, release, status, ack };
}

describe('native node-spawn task transport', () => {
  it('spawns once, captures exact-sender inbox evidence, and leaves ack to the journal caller', async () => {
    const dataDir = await dataDirectory('flows-node-spawn-');
    const f = fixture();
    const result = await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.spawn.mock.calls[0]![0]).toMatchObject({ harness: 'codex', idempotencyKey: 'dispatch_1234567890' });
    expect(f.spawn.mock.calls[0]![0]).not.toHaveProperty('directory');
    expect(f.release).toHaveBeenCalledWith(expect.objectContaining({
      receipt: expect.objectContaining({ agentId: 'agent_1', nodeName: 'desktop-1' }),
    }));
    expect(result.receipt).toMatchObject({
      action_name: 'spawn', status: 'completed', output: { summary: 'done' },
      task_execution: { agent_id: 'agent_1', delivery_id: 'delivery_1', release_invocation_id: 'inv_release_1' },
    });
    expect(f.ack).not.toHaveBeenCalled();
    await result.delivery.ack();
    expect(f.ack).toHaveBeenCalledWith(expect.objectContaining({ inboxItemId: 'delivery_1', state: 'read' }));
  });

  it('recovers a recorded spawn without issuing a second spawn or release', async () => {
    const dataDir = await dataDirectory('flows-node-recover-');
    const f = fixture();
    await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    const recovered = await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.status).toHaveBeenCalledWith('spawn', 'inv_spawn_1');
    expect(recovered.receipt.status).toBe('completed');
  });

  it('fails closed across an ambiguous pre-ack crash instead of spawning twice', async () => {
    const dataDir = await dataDirectory('flows-node-ambiguous-');
    const f = fixture();
    f.spawn.mockRejectedValueOnce(new Error('connection dropped'));
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime })).rejects.toThrow('connection dropped');
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime })).rejects.toThrow('ambiguous pre-ack');
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it('durably releases exact identity attached to a post-spawn verification failure', async () => {
    const dataDir = await dataDirectory('flows-node-postspawn-failure-');
    const f = fixture();
    f.spawn.mockRejectedValueOnce(new NodeSpawnError('task delivery unconfirmed',
      'spawn_task_unconfirmed', undefined, {
        id: 'inv_spawn_1', nodeId: 'node_1', nodeName: 'desktop-1',
        name: 'worker_1', agentId: 'agent_1',
      }));
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime }))
      .rejects.toThrow('task delivery unconfirmed');
    expect(f.release).toHaveBeenCalledWith(expect.objectContaining({
      receipt: expect.objectContaining({ agentId: 'agent_1', nodeName: 'desktop-1' }),
    }));
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime }))
      .rejects.toThrow('task delivery unconfirmed');
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('releases the exact confirmed agent before propagating cancellation', async () => {
    const dataDir = await dataDirectory('flows-node-cancel-');
    const f = fixture();
    const controller = new AbortController();
    f.spawn.mockImplementationOnce(async (input: { name: string }) => {
      queueMicrotask(() => controller.abort(new Error('lease lost')));
      return { id: 'inv_spawn_1', action: 'spawn' as const, status: 'completed' as const,
        nodeId: 'node_1', nodeName: 'desktop-1', name: input.name, agentId: 'agent_1',
        spawned: true as const, ready: true as const };
    });
    const order: string[] = [];
    f.release.mockImplementationOnce(async () => {
      order.push('release');
      return { id: 'inv_release_1', action: 'release' as const,
        status: 'completed' as const, spawned: false, ready: false, released: true };
    });
    try {
      await runAgentRelayTask(request(dataDir), { runtime: f.runtime, signal: controller.signal });
      throw new Error('expected cancellation');
    } catch (error) {
      expect(error).toMatchObject({ message: 'lease lost' });
      order.push('rejected');
    }
    expect(order).toEqual(['release', 'rejected']);
    expect(f.release).toHaveBeenCalledWith(expect.objectContaining({
      receipt: expect.objectContaining({ agentId: 'agent_1', nodeName: 'desktop-1' }),
    }));
  });

  it('returns promptly from a cancelled confirmation and cleans up its late exact receipt', async () => {
    const dataDir = await dataDirectory('flows-node-confirm-cancel-');
    const f = fixture();
    const controller = new AbortController();
    let confirm!: (receipt: NodeSpawnReceipt) => void;
    f.spawn.mockImplementationOnce((input: { name: string }) => new Promise<NodeSpawnReceipt>(resolve => {
      confirm = receipt => resolve({ ...receipt, name: input.name });
    }));
    const pending = runAgentRelayTask(request(dataDir), { runtime: f.runtime, signal: controller.signal });
    await vi.waitFor(() => expect(f.spawn).toHaveBeenCalledOnce());
    controller.abort(new Error('lease lost during confirmation'));
    await expect(pending).rejects.toThrow('lease lost during confirmation');
    expect(f.release).not.toHaveBeenCalled();
    confirm({ id: 'inv_spawn_1', action: 'spawn', status: 'completed', nodeId: 'node_1',
      nodeName: 'desktop-1', name: 'placeholder', agentId: 'agent_1', spawned: true, ready: true });
    await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
  });

  it('rechecks cancellation after durable claiming immediately before spawn dispatch', async () => {
    const dataDir = await dataDirectory('flows-node-prespawn-cancel-');
    const f = fixture();
    const controller = new AbortController();
    const pending = runAgentRelayTask(request(dataDir), { runtime: f.runtime, signal: controller.signal });
    queueMicrotask(() => controller.abort(new Error('lease lost before dispatch')));
    await expect(pending).rejects.toThrow('lease lost before dispatch');
    expect(f.spawn).not.toHaveBeenCalled();
  });

  it('acks the inbox delivery only after stepComplete has entered the journal', async () => {
    const dataDir = await dataDirectory('flows-node-journal-');
    const f = fixture();
    const order: string[] = [];
    f.ack.mockImplementation(async () => { order.push('ack'); return {}; });
    const client = Object.assign(new EventEmitter(), {
      workerAttach: vi.fn(async () => ({})),
      stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 30_000 })),
      stepComplete: vi.fn(async () => { expect(f.ack).not.toHaveBeenCalled(); order.push('journal'); return {}; }),
    });
    const worker = new AgentWorker(client as unknown as JournalClient, {
      workerId: 'worker_1', pins: {}, dataDir, nodeSpawnRuntime: f.runtime,
    });
    const errors: unknown[] = [];
    worker.on('error', error => errors.push(error));
    await worker.attach();
    const dispatch: StepDispatchEvent = {
      run_id: 'run_1', step_id: 'edit', attempt: 1, step_type: 'agent',
      spec: { cli: 'codex', instruction: 'Implement the change', transport: 'relay', model: 'codex-medium' },
      idempotency_key: 'dispatch_1234567890', lease_id: 'lease_1',
      lease_deadline_ms: Date.now() + 30_000, pins: {},
    };
    client.emit('step.dispatch', dispatch);
    await worker.close();
    expect(errors).toEqual([]);
    expect(order).toEqual(['journal', 'ack']);
    expect(client.stepComplete).toHaveBeenCalledWith('run_1', 'edit', 1, 'dispatch_1234567890', 'success',
      expect.objectContaining({ output: { summary: 'done' }, trajectory_tail: {
        relay_task: expect.objectContaining({ invocation_id: 'inv_spawn_1', status: 'completed' }),
      } }));
  });

  it('keeps a result unacked and durably retries exact cleanup when release is unconfirmed', async () => {
    const dataDir = await dataDirectory('flows-node-cleanup-');
    const f = fixture();
    f.release.mockRejectedValueOnce(new Error('release response lost'));
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime }))
      .rejects.toMatchObject({ cleanupPending: true });
    expect(f.ack).not.toHaveBeenCalled();
    const recovered = await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(recovered.receipt.status).toBe('completed');
  });

  it('leaves failed cleanup nonterminal so a worker redispatch can finish exact release', async () => {
    const dataDir = await dataDirectory('flows-node-worker-cleanup-');
    const f = fixture();
    f.release.mockRejectedValueOnce(new Error('release response lost'));
    const client = Object.assign(new EventEmitter(), {
      workerAttach: vi.fn(async () => ({})),
      stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 30_000 })),
      stepComplete: vi.fn(async () => ({})),
    });
    const worker = new AgentWorker(client as unknown as JournalClient, {
      workerId: 'worker_1', pins: {}, dataDir, nodeSpawnRuntime: f.runtime,
    });
    await worker.attach();
    const dispatch = (attempt: number): StepDispatchEvent => ({
      run_id: 'run_1', step_id: 'edit', attempt, step_type: 'agent',
      spec: { cli: 'codex', instruction: 'Implement the change', transport: 'relay' },
      idempotency_key: 'dispatch_1234567890', lease_id: `lease_${attempt}`,
      lease_deadline_ms: Date.now() + 30_000, pins: {},
    });
    const failed = new Promise<unknown>(resolve => worker.once('error', resolve));
    client.emit('step.dispatch', dispatch(1));
    const failure = await failed;
    expect(failure).toBeInstanceOf(AgentRelayTransportError);
    expect(failure).toMatchObject({ cleanupPending: true });
    expect(client.stepComplete).not.toHaveBeenCalled();
    expect(f.ack).not.toHaveBeenCalled();
    client.emit('step.dispatch', dispatch(2));
    await vi.waitFor(() => expect(client.stepComplete).toHaveBeenCalledOnce());
    await worker.close();
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(client.stepComplete).toHaveBeenCalledWith('run_1', 'edit', 2,
      'dispatch_1234567890', 'success', expect.any(Object));
    expect(f.ack).toHaveBeenCalledOnce();
  });

  it('fails immediately when a prior error already released an agent without a result', async () => {
    const dataDir = await dataDirectory('flows-node-released-without-result-');
    const f = fixture();
    f.runtime.inbox.inbox.subscribe = async function* () {};
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime }))
      .rejects.toThrow('inbox ended');
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime }))
      .rejects.toThrow('inbox ended');
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.status).not.toHaveBeenCalled();
  });

  it('retries pending cleanup before failing a result-less spawn recovery', async () => {
    const dataDir = await dataDirectory('flows-node-resultless-cleanup-');
    const f = fixture();
    f.runtime.inbox.inbox.subscribe = async function* () {};
    f.release.mockRejectedValueOnce(new Error('release response lost'));
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime }))
      .rejects.toMatchObject({ cleanupPending: true });
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime }))
      .rejects.toThrow('inbox ended');
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledTimes(2);
    expect(f.status).not.toHaveBeenCalled();
  });

  it('keeps the original deadline across restart and bounds completed-result recovery', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const started = new Date('2026-11-07T00:00:00.000Z');
      vi.setSystemTime(started);
      const dataDir = await dataDirectory('flows-node-deadline-');
      const f = fixture();
      const bounded = { ...request(dataDir), timeoutMs: 1_000 };
      await runAgentRelayTask(bounded, { runtime: f.runtime });
      vi.setSystemTime(started.getTime() + 1_001);
      await expect(runAgentRelayTask(bounded, { runtime: f.runtime })).resolves.toBeDefined();
      expect(f.status).toHaveBeenCalledTimes(1);
      vi.setSystemTime(started.getTime() + 31_001);
      await expect(runAgentRelayTask(bounded, { runtime: f.runtime })).rejects.toThrow('deadline elapsed');
      expect(f.status).toHaveBeenCalledTimes(1);
      expect(f.spawn).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('journals a failed agent envelope before acknowledging its delivery', async () => {
    const dataDir = await dataDirectory('flows-node-failed-result-');
    const f = fixture('failed');
    const order: string[] = [];
    f.ack.mockImplementation(async () => { order.push('ack'); return {}; });
    const client = Object.assign(new EventEmitter(), {
      workerAttach: vi.fn(async () => ({})),
      stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 30_000 })),
      stepComplete: vi.fn(async () => { expect(f.ack).not.toHaveBeenCalled(); order.push('journal'); return {}; }),
    });
    const worker = new AgentWorker(client as unknown as JournalClient, {
      workerId: 'worker_1', pins: {}, dataDir, nodeSpawnRuntime: f.runtime,
    });
    const errors: unknown[] = [];
    worker.on('error', error => errors.push(error));
    await worker.attach();
    client.emit('step.dispatch', {
      run_id: 'run_1', step_id: 'edit', attempt: 1, step_type: 'agent',
      spec: { cli: 'codex', instruction: 'Implement the change', transport: 'relay' },
      idempotency_key: 'dispatch_1234567890', lease_id: 'lease_1',
      lease_deadline_ms: Date.now() + 30_000, pins: {},
    } satisfies StepDispatchEvent);
    await worker.close();
    expect(errors).toEqual([]);
    expect(order).toEqual(['journal', 'ack']);
    expect(client.stepComplete).toHaveBeenCalledWith('run_1', 'edit', 1, 'dispatch_1234567890',
      expect.not.stringMatching(/^success$/), expect.objectContaining({
        trajectory_tail: { relay_task: expect.objectContaining({ status: 'failed', error: 'agent reported failure' }) },
      }));
  });
});
