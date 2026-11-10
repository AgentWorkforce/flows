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
import { readNodeSpawnClaims, recordNodeSpawn } from '../src/node-spawn-state.js';

const request = (dataDir: string): AgentRelayTaskRequest => ({
  cli: 'codex', task: 'Implement the change', runId: 'run_1', stepId: 'edit',
  idempotencyKey: 'dispatch_1234567890', attempt: 1, dataDir, timeoutMs: 10_000,
});

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function dataDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), label));
  roots.push(directory);
  return directory;
}

function fixture(result: 'completed' | 'failed' = 'completed'): { runtime: NodeSpawnRuntime; spawn: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>; status: ReturnType<typeof vi.fn>;
  ack: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } {
  const receipt: NodeSpawnReceipt = {
    id: 'inv_spawn_1', action: 'spawn', status: 'completed', nodeId: 'node_1', nodeName: 'desktop-1',
    name: 'placeholder', agentId: 'agent_1', spawned: true, ready: true,
  };
  const spawn = vi.fn<NodeSpawnPort['spawn']>(async (input, beforeDispatch) => {
    await beforeDispatch();
    return { ...receipt, name: input.name };
  });
  const release = vi.fn(async () => ({ id: 'inv_release_1', action: 'release' as const,
    status: 'completed' as const, spawned: false, ready: false, released: true }));
  const status = vi.fn(async () => ({ ...receipt, name: receipt.name }));
  const ack = vi.fn(async () => ({}));
  const fail = vi.fn(async () => ({}));
  const port: NodeSpawnPort = {
    dispatchFenceVersion: 1, targets: async () => [], spawn, status, release,
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
      fail,
    } },
  };
  return { runtime, spawn, release, status, ack, fail };
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
    await result.delivery.prepareSettlement!({ attempt: 1, completionReason: 'success' });
    await result.delivery.ack();
    expect(f.ack).toHaveBeenCalledWith(expect.objectContaining({ inboxItemId: 'delivery_1', state: 'read' }));
  });

  it('replays a durable result without a second spawn, release, or remote status lookup', async () => {
    const dataDir = await dataDirectory('flows-node-recover-');
    const f = fixture();
    await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    const recovered = await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.status).not.toHaveBeenCalled();
    expect(recovered.receipt.status).toBe('completed');
  });

  it('retains the original inbox teardown barrier across a failed release and cached retry', async () => {
    const dataDir = await dataDirectory('flows-node-release-retry-teardown-');
    const f = fixture();
    let finishTeardown!: () => void;
    const settlementReady = new Promise<{ failure?: unknown }>(resolve => {
      finishTeardown = () => resolve({});
    });
    let delivered = false;
    const subscribe = vi.fn(() => ({ [Symbol.asyncIterator]() { return {
      async next() {
        if (delivered) return new Promise<IteratorResult<never>>(() => undefined);
        delivered = true;
        const name = (await f.spawn.mock.results[0]!.value).name;
        return { done: false as const, value: { id: 'delivery_1', settlementReady,
          message: { id: 'message_1', from: { id: 'agent_1', name },
            text: NODE_RESULT_PREFIX + JSON.stringify({ version: 1, run_id: 'run_1',
              step_id: 'edit', dispatch_id: 'dispatch_1234567890', status: 'completed',
              output: { summary: 'done' }, accounting: { tokens_input: 10, tokens_output: 5 } }) } } };
      },
      async return() { return { done: true as const, value: undefined }; },
    }; } }));
    f.runtime.inbox.inbox.subscribe = subscribe;
    f.release.mockRejectedValueOnce(new Error('release unavailable'));

    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime }))
      .rejects.toThrow('release unavailable');
    const recovered = await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    expect(subscribe).toHaveBeenCalledOnce();
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledTimes(2);
    await recovered.delivery.prepareSettlement!({ attempt: 1, completionReason: 'success' });
    const settling = recovered.delivery.ack();
    const settledBeforeTeardown = await Promise.race([
      settling.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 100)),
    ]);
    expect(settledBeforeTeardown).toBe(false);
    expect(f.ack).not.toHaveBeenCalled();
    expect(f.fail).not.toHaveBeenCalled();
    finishTeardown();
    await settling;
    expect(f.ack).toHaveBeenCalledOnce();
    expect(f.fail).not.toHaveBeenCalled();
  });

  it('replays across changed recovery text while stable task identity remains exact', async () => {
    const dataDir = await dataDirectory('flows-node-recover-task-identity-');
    const f = fixture();
    const initial = { ...request(dataDir), taskIdentity: 'Implement the change',
      result_schema: { type: 'object', required: ['summary'] } };
    await runAgentRelayTask(initial, { runtime: f.runtime });
    const recovered = await runAgentRelayTask({
      ...initial,
      task: `${initial.task}\n\nPrevious attempt (journaled):\n${JSON.stringify({
        completion_reason: 'crashed', trajectory_tail: { note: 'retry' },
      })}`,
      attempt: 2,
    }, { runtime: f.runtime });
    expect(recovered.receipt.status).toBe('completed');
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();

    await expect(runAgentRelayTask({
      ...initial, taskIdentity: 'A different authored task', attempt: 2,
    }, { runtime: f.runtime })).rejects.toThrow('conflicts with its durable identity or input');
    await expect(runAgentRelayTask({
      ...initial, result_schema: { type: 'object', required: ['different'] }, attempt: 2,
    }, { runtime: f.runtime })).rejects.toThrow('conflicts with its durable identity or input');
  });

  it('fails closed across an ambiguous pre-ack crash instead of spawning twice', async () => {
    const dataDir = await dataDirectory('flows-node-ambiguous-');
    const f = fixture();
    f.spawn.mockImplementationOnce(async (_input, beforeDispatch) => {
      await beforeDispatch();
      throw new Error('connection dropped');
    });
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime })).rejects.toThrow('connection dropped');
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime })).rejects.toThrow('ambiguous pre-ack');
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it('durably releases exact identity attached to a post-spawn verification failure', async () => {
    const dataDir = await dataDirectory('flows-node-postspawn-failure-');
    const f = fixture();
    f.spawn.mockImplementationOnce(async (_input, beforeDispatch) => {
      await beforeDispatch();
      throw new NodeSpawnError('task delivery unconfirmed',
        'spawn_task_unconfirmed', undefined, {
        id: 'inv_spawn_1', nodeId: 'node_1', nodeName: 'desktop-1',
        name: 'worker_1', agentId: 'agent_1',
        });
    });
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
    f.spawn.mockImplementationOnce(async (input, beforeDispatch) => {
      await beforeDispatch();
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
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime })).rejects.toMatchObject({
      cause: expect.objectContaining({ code: 'task_cancelled' }),
    });
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.status).not.toHaveBeenCalled();
  });

  it('refuses to extend the original durable execution deadline on redispatch', async () => {
    const dataDir = await dataDirectory('flows-node-deadline-identity-');
    const f = fixture();
    const controller = new AbortController();
    f.spawn.mockImplementationOnce(async (input, beforeDispatch) => {
      await beforeDispatch();
      queueMicrotask(() => controller.abort(new Error('worker stopped')));
      return { id: 'inv_spawn_1', action: 'spawn' as const, status: 'completed' as const,
        nodeId: 'node_1', nodeName: 'desktop-1', name: input.name, agentId: 'agent_1',
        spawned: true as const, ready: true as const };
    });
    await expect(runAgentRelayTask({ ...request(dataDir), timeoutMs: 1_000 }, {
      runtime: f.runtime, signal: controller.signal,
    })).rejects.toThrow('worker stopped');
    await expect(runAgentRelayTask({ ...request(dataDir), timeoutMs: 60_000 }, { runtime: f.runtime }))
      .rejects.toThrow('conflicts with its durable identity or input');
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('bounds a recovered spawn status lookup by the original deadline and releases exact identity', async () => {
    vi.useFakeTimers();
    try {
      const dataDir = await dataDirectory('flows-node-status-stall-');
      const f = fixture();
      const bounded = { ...request(dataDir), timeoutMs: 1_000 };
      await runAgentRelayTask(bounded, { runtime: f.runtime });
      const [entry] = await readNodeSpawnClaims(dataDir);
      const { result: _result, release: _release, ...spawnOnly } = entry!.claim;
      await recordNodeSpawn(entry!.path, spawnOnly);
      f.status.mockImplementationOnce(() => new Promise(() => undefined));
      const pending = expect(runAgentRelayTask(bounded, { runtime: f.runtime }))
        .rejects.toThrow();
      await vi.waitFor(() => expect(f.status).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(1_001);
      await pending;
      expect(f.release).toHaveBeenCalledTimes(2);
      const [recovered] = await readNodeSpawnClaims(dataDir);
      expect(recovered!.claim.release).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('returns promptly from a cancelled confirmation and cleans up its late exact receipt', async () => {
    const dataDir = await dataDirectory('flows-node-confirm-cancel-');
    const f = fixture();
    const controller = new AbortController();
    let confirm!: (receipt: NodeSpawnReceipt) => void;
    f.spawn.mockImplementationOnce(async (input, beforeDispatch) => {
      await beforeDispatch();
      return new Promise<NodeSpawnReceipt>(resolve => {
      confirm = receipt => resolve({ ...receipt, name: input.name });
      });
    });
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

  it('bounds a stalled exact release and retries it from durable cleanup state', async () => {
    vi.useFakeTimers();
    try {
      const dataDir = await dataDirectory('flows-node-cleanup-stall-');
      const f = fixture();
      f.release.mockImplementationOnce(() => new Promise(() => undefined));
      const task = runAgentRelayTask({ ...request(dataDir), timeoutMs: 60_000 }, { runtime: f.runtime });
      const rejection = expect(task).rejects.toMatchObject({ cleanupPending: true });
      await vi.waitFor(() => expect(f.release).toHaveBeenCalledOnce());
      await vi.advanceTimersByTimeAsync(15_001);
      await rejection;
      expect(f.ack).not.toHaveBeenCalled();
      const claims = await readNodeSpawnClaims(dataDir);
      expect(claims[0]!.claim.cleanupPending).toMatchObject({
        attempts: 1,
        lastError: expect.stringContaining('independent deadline'),
      });
      const recovered = await runAgentRelayTask({ ...request(dataDir), timeoutMs: 60_000 }, { runtime: f.runtime });
      expect(f.release).toHaveBeenCalledTimes(2);
      expect(recovered.receipt.status).toBe('completed');
    } finally {
      vi.useRealTimers();
    }
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

  it('releases a durably failed spawn before any status or inbox recovery', async () => {
    const dataDir = await dataDirectory('flows-node-failure-before-cleanup-');
    const f = fixture();
    await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    const [entry] = await readNodeSpawnClaims(dataDir);
    const { result: _result, release: _release, cleanupPending: _pending, ...spawned } = entry!.claim;
    await recordNodeSpawn(entry!.path, { ...spawned,
      failure: { code: 'spawn_cancelled', message: 'worker stopped after spawn' } });
    f.release.mockClear();
    f.status.mockClear();
    f.runtime.inbox.inbox.subscribe = async function* () { throw new Error('inbox must not be read'); };
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime }))
      .rejects.toThrow('worker stopped after spawn');
    expect(f.release).toHaveBeenCalledOnce();
    expect(f.status).not.toHaveBeenCalled();
  });

  it('keeps the original execution deadline but never expires a durably observed result', async () => {
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
      expect(f.status).not.toHaveBeenCalled();
      vi.setSystemTime(started.getTime() + 31_001);
      f.runtime.inbox.inbox.subscribe = async function* () { throw new Error('must use durable envelope'); };
      await expect(runAgentRelayTask(bounded, { runtime: f.runtime })).resolves.toBeDefined();
      expect(f.status).not.toHaveBeenCalled();
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

  it('journals a malformed exact-sender envelope before dead-lettering its delivery', async () => {
    const dataDir = await dataDirectory('flows-node-malformed-result-');
    const f = fixture();
    f.runtime.inbox.inbox.subscribe = async function* () {
      const name = (await f.spawn.mock.results[0]!.value).name;
      yield { id: 'delivery_1', message: { id: 'message_1',
        from: { id: 'agent_1', name },
        text: NODE_RESULT_PREFIX + '{bad',
      } };
    };
    const order: string[] = [];
    f.fail.mockImplementation(async () => { order.push('fail'); return {}; });
    const client = Object.assign(new EventEmitter(), {
      workerAttach: vi.fn(async () => ({})),
      stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 30_000 })),
      stepComplete: vi.fn(async () => { expect(f.fail).not.toHaveBeenCalled(); order.push('journal'); return {}; }),
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
    expect(order).toEqual(['journal', 'fail']);
    expect(f.ack).not.toHaveBeenCalled();
    expect(f.fail).toHaveBeenCalledWith(expect.objectContaining({ inboxItemId: 'delivery_1', retry: false }));
  });
});
