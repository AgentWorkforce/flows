import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NODE_RESULT_PREFIX } from '../src/node-spawn-result.js';
import { runAgentRelayTask } from '../src/agent-relay-transport.js';
import type { NodeSpawnRuntime } from '../src/node-spawn-runtime.js';
import type { NodeSpawnPort } from '../src/node-spawn.js';
import type { JournalClient } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';
import { WorkerLeaseLostError } from '../src/worker-lease.js';

const owner = vi.hoisted(() => ({ get: vi.fn(), close: vi.fn(async () => {}) }));
vi.mock('../src/node-spawn-runtime.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/node-spawn-runtime.js')>(),
  createNodeSpawnRuntimeOwner: () => owner,
}));

import { AgentWorker } from '../src/worker.js';

const roots: string[] = [];
afterEach(async () => {
  owner.get.mockReset();
  owner.close.mockClear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('AgentWorker node-spawn runtime ownership', () => {
  it('closes the shared runtime even when final durable inbox settlement still fails', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'flows-shared-node-runtime-settlement-failure-'));
    roots.push(dataDir);
    const ack = vi.fn(async () => { throw new Error('inbox unavailable'); });
    let spawnedName = '';
    const runtime: NodeSpawnRuntime = {
      publisher: { id: 'publisher_1', name: 'flows-publisher' },
      baseUrl: 'https://cast.agentrelay.com',
      port: {
        targets: async () => [],
        spawn: async input => {
          spawnedName = input.name;
          return { id: 'spawn_1', action: 'spawn', status: 'completed',
            nodeId: 'node_1', nodeName: 'desktop-1', name: input.name, agentId: 'agent_1',
            spawned: true, ready: true };
        },
        status: vi.fn(),
        release: async () => ({ id: 'release_1', action: 'release', status: 'completed',
          spawned: false, ready: false, released: true }),
      },
      inbox: { inbox: {
        subscribe: async function* () {
          yield { id: 'delivery_1', message: { id: 'message_1',
            from: { id: 'agent_1', name: spawnedName },
            text: NODE_RESULT_PREFIX + JSON.stringify({ version: 1, run_id: 'run_1',
              step_id: 'edit', dispatch_id: 'dispatch_1234567890', status: 'completed',
              output: { summary: 'done' } }) } };
        },
        ack,
        fail: vi.fn(async () => ({})),
      } },
    };
    const received = await runAgentRelayTask({
      cli: 'codex', task: 'Implement the change', runId: 'run_1', stepId: 'edit',
      idempotencyKey: 'dispatch_1234567890', attempt: 1, dataDir,
    }, { runtime });
    await received.delivery.prepareSettlement!({ attempt: 1, completionReason: 'success' });
    owner.get.mockResolvedValue(runtime);
    const client = Object.assign(new EventEmitter(), {
      workerAttach: vi.fn(async () => ({})),
      journalRead: vi.fn(async () => ({ entries: [{
        seq: 2, segment_id: 0, entry_type: 'step.completed', run_id: 'run_1',
        step_id: 'edit', attempt: 1, at_ms: Date.now(), payload: {
          completionReason: 'success', trajectory_tail: { relay_task: { task_execution: {
            run_id: 'run_1', step_id: 'edit', dispatch_id: 'dispatch_1234567890',
            delivery_id: 'delivery_1', message_id: 'message_1',
          } } },
        },
      }] })),
    });
    const worker = new AgentWorker(client as unknown as JournalClient, {
      workerId: 'worker_recovery', pins: {}, dataDir,
    });
    await expect(worker.attach()).rejects.toThrow('inbox unavailable');
    expect(owner.close).toHaveBeenCalledOnce();
    await expect(worker.close()).resolves.toBeUndefined();
    expect(ack).toHaveBeenCalledOnce();
    expect(owner.close).toHaveBeenCalledOnce();
  });

  it('shares one runtime and one concurrent close promise through dispatch drain', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'flows-shared-node-runtime-'));
    roots.push(dataDir);
    const dispatches = [dispatch('edit-a', 'dispatch_aaaaaaaaaa'), dispatch('edit-b', 'dispatch_bbbbbbbbbb')];
    const spawned: Array<{ name: string; agentId: string; key: string }> = [];
    const order: string[] = [];
    let bothSpawned!: () => void;
    const ready = new Promise<void>(resolve => { bothSpawned = resolve; });
    let bothJournalsStarted!: () => void;
    const journalsStarted = new Promise<void>(resolve => { bothJournalsStarted = resolve; });
    let allowJournals!: () => void;
    const journalGate = new Promise<void>(resolve => { allowJournals = resolve; });
    let ownerCloseStarted!: () => void;
    const closeStarted = new Promise<void>(resolve => { ownerCloseStarted = resolve; });
    let allowOwnerClose!: () => void;
    const ownerCloseGate = new Promise<void>(resolve => { allowOwnerClose = resolve; });
    const ack = vi.fn(async ({ inboxItemId }: { inboxItemId: string }) => {
      order.push(`ack:${inboxItemId}`);
      return {};
    });
    const spawn = vi.fn<NodeSpawnPort['spawn']>(async input => {
      const agentId = `agent_${spawned.length + 1}`;
      spawned.push({ name: input.name, agentId, key: input.idempotencyKey });
      if (spawned.length === 2) bothSpawned();
      return { id: `spawn_${agentId}`, action: 'spawn', status: 'completed',
        nodeId: 'node_1', nodeName: 'desktop-1', name: input.name, agentId,
        spawned: true, ready: true };
    });
    const release = vi.fn<NodeSpawnPort['release']>(async input => {
      order.push(`release:${input.receipt.agentId}`);
      return { id: `release_${input.receipt.agentId}`, action: 'release', status: 'completed',
        spawned: false, ready: false, released: true };
    });
    const runtime: NodeSpawnRuntime = {
      publisher: { id: 'publisher_1', name: 'flows-publisher' },
      baseUrl: 'https://cast.agentrelay.com',
      port: {
        targets: async () => [],
        spawn,
        status: vi.fn(),
        release,
      },
      inbox: { inbox: {
        subscribe: async function* () {
          await ready;
          for (const item of spawned) {
            const expected = dispatches.find(value => value.idempotency_key === item.key)!;
            yield { id: `delivery_${item.agentId}`, message: { id: `message_${item.agentId}`,
              from: { id: item.agentId, name: item.name },
              text: NODE_RESULT_PREFIX + JSON.stringify({ version: 1, run_id: expected.run_id,
                step_id: expected.step_id, dispatch_id: expected.idempotency_key,
                status: 'completed', output: { step: expected.step_id },
                accounting: { tokens_input: 1, tokens_output: 1 } }) } };
          }
        },
        ack,
        fail: vi.fn(async () => ({})),
      } },
    };
    owner.get.mockResolvedValue(runtime);
    owner.close.mockImplementation(async () => {
      order.push('close');
      ownerCloseStarted();
      await ownerCloseGate;
    });
    let journalCalls = 0;
    const stepComplete = vi.fn<JournalClient['stepComplete']>(async (_runId, stepId) => {
      order.push(`journal:${stepId}`);
      journalCalls += 1;
      if (journalCalls === dispatches.length) bothJournalsStarted();
      await journalGate;
      return {} as Awaited<ReturnType<JournalClient['stepComplete']>>;
    });
    const client = Object.assign(new EventEmitter(), {
      workerAttach: vi.fn(async () => ({})),
      stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 30_000 })),
      stepComplete,
      supportsFeature: vi.fn(() => true),
    });
    const worker = new AgentWorker(client as unknown as JournalClient, {
      workerId: 'worker_1', pins: {}, capacity: 2, dataDir,
    });
    const errors: unknown[] = [];
    worker.on('error', error => errors.push(error));
    await worker.attach();
    for (const value of dispatches) client.emit('step.dispatch', value);
    const firstClose = worker.close();
    const secondClose = worker.close();
    expect(secondClose).toBe(firstClose);
    let firstSettled = false;
    let secondSettled = false;
    void firstClose.then(() => { firstSettled = true; });
    void secondClose.then(() => { secondSettled = true; });

    await journalsStarted;
    await Promise.resolve();
    expect([firstSettled, secondSettled]).toEqual([false, false]);
    expect(owner.close).not.toHaveBeenCalled();

    allowJournals();
    await closeStarted;
    await Promise.resolve();
    expect(owner.close).toHaveBeenCalledOnce();
    expect([firstSettled, secondSettled]).toEqual([false, false]);

    allowOwnerClose();
    await Promise.all([firstClose, secondClose]);
    expect([firstSettled, secondSettled]).toEqual([true, true]);

    expect(errors).toEqual([]);
    expect(owner.get).toHaveBeenCalledTimes(2);
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(stepComplete).toHaveBeenCalledTimes(2);
    expect(stepComplete.mock.calls.map(call => [call[1], call[4], call[5]?.output]))
      .toEqual(expect.arrayContaining([
        ['edit-a', 'success', { step: 'edit-a' }],
        ['edit-b', 'success', { step: 'edit-b' }],
      ]));
    expect(ack).toHaveBeenCalledTimes(2);
    expect(owner.close).toHaveBeenCalledOnce();
    for (const item of spawned) {
      const stepId = dispatches.find(value => value.idempotency_key === item.key)!.step_id;
      const releaseIndex = order.indexOf(`release:${item.agentId}`);
      const journalIndex = order.indexOf(`journal:${stepId}`);
      const ackIndex = order.indexOf(`ack:delivery_${item.agentId}`);
      const closeIndex = order.indexOf('close');
      expect([releaseIndex, journalIndex, ackIndex, closeIndex].every(index => index >= 0)).toBe(true);
      expect(releaseIndex).toBeLessThan(journalIndex);
      expect(journalIndex).toBeLessThan(ackIndex);
      expect(ackIndex).toBeLessThan(closeIndex);
    }
    expect(order.at(-1)).toBe('close');
  });

  it('drains a six-task mixed-order fan with one lease cancellation before closing the shared runtime', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'flows-shared-node-runtime-fan-'));
    roots.push(dataDir);
    const cancelledIndex = 2;
    const dispatches = Array.from({ length: 6 }, (_, index) => dispatch(
      `edit-${index}`,
      `dispatch_${String(index).padStart(10, '0')}`,
      index === cancelledIndex ? 300 : 30_000,
    ));
    const spawned: Array<{ name: string; agentId: string; key: string }> = [];
    const order: string[] = [];
    let allSpawned!: () => void;
    const spawnedGate = new Promise<void>(resolve => { allSpawned = resolve; });
    let allowResults!: () => void;
    const resultsGate = new Promise<void>(resolve => { allowResults = resolve; });
    const completionOrder = [5, 1, 4, 0, 3];
    const ack = vi.fn(async ({ inboxItemId }: { inboxItemId: string }) => {
      order.push(`ack:${inboxItemId}`);
      return {};
    });
    const spawn = vi.fn<NodeSpawnPort['spawn']>(async input => {
      const agentId = `agent_${spawned.length}`;
      spawned.push({ name: input.name, agentId, key: input.idempotencyKey });
      if (spawned.length === dispatches.length) allSpawned();
      return { id: `spawn_${agentId}`, action: 'spawn', status: 'completed',
        nodeId: 'node_1', nodeName: 'desktop-1', name: input.name, agentId,
        spawned: true, ready: true };
    });
    const release = vi.fn<NodeSpawnPort['release']>(async input => {
      order.push(`release:${input.receipt.agentId}`);
      return { id: `release_${input.receipt.agentId}`, action: 'release', status: 'completed',
        spawned: false, ready: false, released: true };
    });
    const runtime: NodeSpawnRuntime = {
      publisher: { id: 'publisher_1', name: 'flows-publisher' },
      baseUrl: 'https://cast.agentrelay.com',
      port: { targets: async () => [], spawn, status: vi.fn(), release },
      inbox: { inbox: {
        subscribe: async function* () {
          await spawnedGate;
          await resultsGate;
          for (const index of completionOrder) {
            const expected = dispatches[index]!;
            const item = spawned.find(value => value.key === expected.idempotency_key)!;
            yield { id: `delivery_${item.agentId}`, message: { id: `message_${item.agentId}`,
              from: { id: item.agentId, name: item.name },
              text: NODE_RESULT_PREFIX + JSON.stringify({ version: 1, run_id: expected.run_id,
                step_id: expected.step_id, dispatch_id: expected.idempotency_key,
                status: 'completed', output: { step: expected.step_id },
                accounting: { tokens_input: 1, tokens_output: 1 } }) } };
          }
          await new Promise(() => {});
        },
        ack,
        fail: vi.fn(async () => ({})),
      } },
    };
    owner.get.mockResolvedValue(runtime);
    owner.close.mockImplementation(async () => { order.push('close'); });
    const heartbeatCalls = new Map<string, number>();
    const stepHeartbeat = vi.fn<JournalClient['stepHeartbeat']>(async (_runId, stepId) => {
      const count = (heartbeatCalls.get(stepId) ?? 0) + 1;
      heartbeatCalls.set(stepId, count);
      if (stepId === dispatches[cancelledIndex]!.step_id && count > 1) {
        throw new WorkerLeaseLostError('renewal_expired', 'review cancellation');
      }
      const ttl = stepId === dispatches[cancelledIndex]!.step_id ? 300 : 30_000;
      return { lease_deadline_ms: Date.now() + ttl, lease_ttl_ms: ttl };
    });
    const stepComplete = vi.fn<JournalClient['stepComplete']>(async (_runId, stepId) => {
      order.push(`journal:${stepId}`);
      return {} as Awaited<ReturnType<JournalClient['stepComplete']>>;
    });
    const client = Object.assign(new EventEmitter(), {
      workerAttach: vi.fn(async () => ({})),
      stepHeartbeat,
      stepComplete,
      supportsFeature: vi.fn(() => true),
    });
    const worker = new AgentWorker(client as unknown as JournalClient, {
      workerId: 'worker_fan', pins: {}, capacity: dispatches.length, dataDir,
    });
    const errors: Array<{ error: unknown; stepId: string }> = [];
    worker.on('error', (error, value: StepDispatchEvent) => {
      errors.push({ error, stepId: value.step_id });
      order.push(`error:${value.step_id}`);
    });
    await worker.attach();
    for (const value of dispatches) client.emit('step.dispatch', value);
    await spawnedGate;

    const firstClose = worker.close();
    const secondClose = worker.close();
    expect(secondClose).toBe(firstClose);
    let closed = false;
    void firstClose.then(() => { closed = true; });
    await Promise.resolve();
    expect(closed).toBe(false);
    expect(owner.close).not.toHaveBeenCalled();

    allowResults();
    await firstClose;

    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      error: { name: 'WorkerLeaseLostError', reason: 'renewal_expired' },
      stepId: dispatches[cancelledIndex]!.step_id,
    });
    expect(owner.get).toHaveBeenCalledTimes(dispatches.length);
    expect(spawn).toHaveBeenCalledTimes(dispatches.length);
    expect(release).toHaveBeenCalledTimes(dispatches.length);
    expect(stepComplete).toHaveBeenCalledTimes(dispatches.length - 1);
    expect(ack).toHaveBeenCalledTimes(dispatches.length - 1);
    expect(owner.close).toHaveBeenCalledOnce();
    for (const index of completionOrder) {
      const expected = dispatches[index]!;
      const item = spawned.find(value => value.key === expected.idempotency_key)!;
      const stepId = expected.step_id;
      const releaseIndex = order.indexOf(`release:${item.agentId}`);
      const journalIndex = order.indexOf(`journal:${stepId}`);
      const ackIndex = order.indexOf(`ack:delivery_${item.agentId}`);
      const closeIndex = order.indexOf('close');
      expect(releaseIndex).toBeLessThan(journalIndex);
      expect(journalIndex).toBeLessThan(ackIndex);
      expect(ackIndex).toBeLessThan(closeIndex);
    }
    const cancelled = spawned.find(value => value.key === dispatches[cancelledIndex]!.idempotency_key)!;
    expect(order.indexOf(`release:${cancelled.agentId}`))
      .toBeLessThan(order.indexOf(`error:${dispatches[cancelledIndex]!.step_id}`));
    expect(order.indexOf(`error:${dispatches[cancelledIndex]!.step_id}`))
      .toBeLessThan(order.indexOf('close'));
    expect(order.at(-1)).toBe('close');
  });
});

function dispatch(stepId: string, idempotencyKey: string, leaseTtlMs?: number): StepDispatchEvent {
  return {
    run_id: 'run_parallel', step_id: stepId, attempt: 1, step_type: 'agent',
    spec: { cli: 'codex', model: 'codex-medium', instruction: `Implement ${stepId}`, transport: 'relay' },
    idempotency_key: idempotencyKey, lease_id: `lease_${stepId}`,
    lease_deadline_ms: Date.now() + (leaseTtlMs ?? 30_000),
    ...(leaseTtlMs === undefined ? {} : { lease_ttl_ms: leaseTtlMs }),
    pins: {},
  };
}
