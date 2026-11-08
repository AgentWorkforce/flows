import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { runAgentRelayTask, type AgentRelayTaskRequest } from '../src/agent-relay-transport.js';
import { NODE_RESULT_PREFIX } from '../src/node-spawn-result.js';
import type { NodeSpawnRuntime } from '../src/node-spawn-runtime.js';
import type { NodeSpawnPort, NodeSpawnReceipt } from '../src/node-spawn.js';
import { EventEmitter } from 'node:events';
import { AgentWorker } from '../src/worker.js';
import type { JournalClient } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';

const request = (dataDir: string): AgentRelayTaskRequest => ({
  cli: 'codex', task: 'Implement the change', runId: 'run_1', stepId: 'edit',
  idempotencyKey: 'dispatch_1234567890', dataDir, timeoutMs: 10_000,
});

function fixture(): { runtime: NodeSpawnRuntime; spawn: ReturnType<typeof vi.fn>;
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
              status: 'completed', output: { summary: 'done' },
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
    const dataDir = await mkdtemp(join(tmpdir(), 'flows-node-spawn-'));
    const f = fixture();
    const result = await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.spawn.mock.calls[0]![0]).toMatchObject({ harness: 'codex', idempotencyKey: 'dispatch_1234567890' });
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
    const dataDir = await mkdtemp(join(tmpdir(), 'flows-node-recover-'));
    const f = fixture();
    await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    const recovered = await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    expect(f.spawn).toHaveBeenCalledTimes(1);
    expect(f.release).toHaveBeenCalledTimes(1);
    expect(f.status).toHaveBeenCalledWith('spawn', 'inv_spawn_1');
    expect(recovered.receipt.status).toBe('completed');
  });

  it('fails closed across an ambiguous pre-ack crash instead of spawning twice', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'flows-node-ambiguous-'));
    const f = fixture();
    f.spawn.mockRejectedValueOnce(new Error('connection dropped'));
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime })).rejects.toThrow('connection dropped');
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime })).rejects.toThrow('ambiguous pre-ack');
    expect(f.spawn).toHaveBeenCalledTimes(1);
  });

  it('releases the exact confirmed agent before propagating cancellation', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'flows-node-cancel-'));
    const f = fixture();
    const controller = new AbortController();
    f.spawn.mockImplementationOnce(async (input: { name: string }) => {
      queueMicrotask(() => controller.abort(new Error('lease lost')));
      return { id: 'inv_spawn_1', action: 'spawn' as const, status: 'completed' as const,
        nodeId: 'node_1', nodeName: 'desktop-1', name: input.name, agentId: 'agent_1',
        spawned: true as const, ready: true as const };
    });
    await expect(runAgentRelayTask(request(dataDir), {
      runtime: f.runtime, signal: controller.signal,
    })).rejects.toThrow('lease lost');
    expect(f.release).toHaveBeenCalledWith(expect.objectContaining({
      receipt: expect.objectContaining({ agentId: 'agent_1', nodeName: 'desktop-1' }),
    }));
  });

  it('acks the inbox delivery only after stepComplete has entered the journal', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'flows-node-journal-'));
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
});
