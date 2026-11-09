import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
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
  vi.unstubAllEnvs();
  owner.get.mockReset();
  owner.close.mockClear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

describe('AgentWorker node-spawn runtime ownership', () => {
  it.each([
    { label: 'Desktop caller', serviceCallerFile: '/tmp/caller.json', authority: undefined,
      provideRuntime: false, expectedDirectory: 'run-root', expectedSpawn: true },
    { label: 'provided Desktop runtime', serviceCallerFile: undefined, authority: 'desktop' as const,
      provideRuntime: true, expectedDirectory: 'run-root', expectedSpawn: true },
    { label: 'remote publisher', serviceCallerFile: undefined, authority: 'remote' as const,
      provideRuntime: true, inheritedCaller: true, expectedDirectory: undefined, expectedSpawn: true },
    { label: 'inherited caller cleared by worker environment', serviceCallerFile: undefined,
      authority: undefined, provideRuntime: false, inheritedCaller: true, environmentCaller: '',
      expectedDirectory: undefined, expectedSpawn: true },
    { label: 'Desktop caller with declared cwd', serviceCallerFile: '/tmp/caller.json', authority: undefined,
      provideRuntime: false, cwd: 'checkout', expectedDirectory: 'declared', expectedSpawn: true },
    { label: 'remote publisher with declared cwd', serviceCallerFile: undefined, authority: 'remote' as const,
      provideRuntime: true, cwd: 'checkout', expectedDirectory: undefined, expectedSpawn: false },
  ])('routes the run directory only for the $label', async testCase => {
    const runRoot = await mkdtemp(join(tmpdir(), 'flows-node-worker-run-root-'));
    roots.push(runRoot);
    if (testCase.inheritedCaller) {
      vi.stubEnv('RELAYFLOW_SERVICE_CALLER_FILE', '/tmp/inherited-caller.json');
    }
    const declaredDirectory = join(runRoot, 'checkout');
    await mkdir(declaredDirectory);
    const exactDeclaredDirectory = await realpath(declaredDirectory);
    let spawnedName = '';
    const spawn = vi.fn<NodeSpawnPort['spawn']>(async input => {
      spawnedName = input.name;
      return { id: 'spawn_worker_path', action: 'spawn', status: 'completed',
        nodeId: 'node_1', nodeName: 'desktop-1', name: input.name, agentId: 'agent_worker_path',
        spawned: true, ready: true };
    });
    const runtime: NodeSpawnRuntime = {
      publisher: { id: 'publisher_1', name: 'flows-publisher' },
      baseUrl: 'https://cast.agentrelay.com',
      ...(testCase.authority === undefined ? {} : { authority: testCase.authority }),
      port: { targets: async () => [], spawn, status: vi.fn(),
        release: vi.fn(async () => ({ id: 'release_worker_path', action: 'release' as const,
          status: 'completed' as const, spawned: false, ready: false, released: true })) },
      inbox: { inbox: {
        subscribe: async function* () {
          yield { id: 'delivery_worker_path', message: { id: 'message_worker_path',
            from: { id: 'agent_worker_path', name: spawnedName },
            text: NODE_RESULT_PREFIX + JSON.stringify({ version: 1, run_id: 'run_parallel',
              step_id: 'edit-local-path', dispatch_id: 'dispatch_localpath', status: 'completed',
              output: { summary: 'done' } }) } };
        },
        ack: vi.fn(async () => ({})), fail: vi.fn(async () => ({})),
      } },
    };
    owner.get.mockResolvedValue(runtime);
    const client = Object.assign(new EventEmitter(), {
      workerAttach: vi.fn(async () => ({})),
      stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 30_000 })),
      stepComplete: vi.fn(async () => ({})),
      supportsFeature: vi.fn(() => true),
    });
    const worker = new AgentWorker(client as unknown as JournalClient, {
      workerId: `worker_${testCase.label}`, pins: {}, dataDir: join(runRoot, 'data'), runRoot,
      ...(testCase.serviceCallerFile === undefined ? {} : { serviceCallerFile: testCase.serviceCallerFile }),
      ...(testCase.provideRuntime ? { nodeSpawnRuntime: runtime } : {}),
      ...(testCase.environmentCaller === undefined
        ? {}
        : { environment: { RELAYFLOW_SERVICE_CALLER_FILE: testCase.environmentCaller } }),
    });
    await worker.attach();
    const value = dispatch('edit-local-path', 'dispatch_localpath');
    if (testCase.cwd !== undefined) {
      value.spec = { ...(value.spec as Record<string, unknown>), cwd: testCase.cwd };
    }
    client.emit('step.dispatch', value);
    await worker.close();
    expect(spawn).toHaveBeenCalledTimes(testCase.expectedSpawn ? 1 : 0);
    if (testCase.expectedSpawn) {
      expect(spawn.mock.calls[0]![0].directory).toBe(testCase.expectedDirectory === 'run-root'
        ? runRoot : testCase.expectedDirectory === 'declared' ? exactDeclaredDirectory : undefined);
    }
  });

  it('does not reconcile a journaled delivery while its live iterator teardown is unresolved', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'flows-node-live-teardown-reconcile-'));
    roots.push(dataDir);
    let finishTeardown!: () => void;
    const settlementReady = new Promise<{ failure?: unknown }>(resolve => {
      finishTeardown = () => resolve({});
    });
    let spawnedName = '';
    let delivered = false;
    const ack = vi.fn(async () => ({}));
    const fail = vi.fn(async () => ({}));
    const runtime: NodeSpawnRuntime = {
      authority: 'desktop', publisher: { id: 'publisher_1', name: 'flows-publisher' },
      baseUrl: 'https://cast.agentrelay.com',
      port: {
        targets: async () => [],
        spawn: async input => {
          spawnedName = input.name;
          return { id: 'spawn_live_teardown', action: 'spawn', status: 'completed',
            nodeId: 'node_1', nodeName: 'desktop-1', name: input.name,
            agentId: 'agent_live_teardown', spawned: true, ready: true };
        },
        status: vi.fn(),
        release: async () => ({ id: 'release_live_teardown', action: 'release',
          status: 'completed', spawned: false, ready: false, released: true }),
      },
      inbox: { inbox: {
        subscribe: () => ({ [Symbol.asyncIterator]() { return {
          async next() {
            if (delivered) return new Promise<IteratorResult<never>>(() => undefined);
            delivered = true;
            return { done: false as const, value: {
              id: 'delivery_live_teardown', settlementReady,
              message: { id: 'message_live_teardown',
                from: { id: 'agent_live_teardown', name: spawnedName },
                text: NODE_RESULT_PREFIX + JSON.stringify({ version: 1, run_id: 'run_parallel',
                  step_id: 'edit-live-teardown', dispatch_id: 'dispatch_liveteardown',
                  status: 'completed', output: { summary: 'done' } }) },
            } };
          },
          async return() { await settlementReady; return { done: true as const, value: undefined }; },
        }; } }),
        ack,
        fail,
      } },
    };
    owner.get.mockResolvedValue(runtime);
    let completed = false;
    let terminalPayload: Record<string, unknown> = {};
    const stepComplete = vi.fn<JournalClient['stepComplete']>(async (
      _runId, _stepId, _attempt, _idempotencyKey, completionReason, payload,
    ) => {
      completed = true;
      terminalPayload = { ...payload, completionReason };
      return {} as Awaited<ReturnType<JournalClient['stepComplete']>>;
    });
    const client = Object.assign(new EventEmitter(), {
      workerAttach: vi.fn(async () => ({})),
      stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 30_000 })),
      stepComplete,
      journalRead: vi.fn(async () => ({ entries: completed ? [{
        seq: 2, segment_id: 0, entry_type: 'step.completed', run_id: 'run_parallel',
        step_id: 'edit-live-teardown', attempt: 1, at_ms: Date.now(), payload: terminalPayload,
      }] : [] })),
      supportsFeature: vi.fn(() => true),
    });
    const worker = new AgentWorker(client as unknown as JournalClient, {
      workerId: 'worker_live_teardown', pins: {}, dataDir, nodeSpawnRuntime: runtime,
    });
    const errors: unknown[] = [];
    worker.on('error', error => errors.push(error));
    await worker.attach();
    vi.useFakeTimers();
    try {
      client.emit('step.dispatch', dispatch('edit-live-teardown', 'dispatch_liveteardown'));
      await vi.waitFor(() => expect(client.stepComplete).toHaveBeenCalledOnce());
      expect(ack).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(10_001);
      await vi.waitFor(() => expect(errors).toHaveLength(1));
      const state = worker as unknown as { reconcileRelaySettlementsAfterDrain(): Promise<void> };
      await state.reconcileRelaySettlementsAfterDrain();
      expect(ack).not.toHaveBeenCalled();
      expect(fail).not.toHaveBeenCalled();

      finishTeardown();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(5_001);
      await vi.waitFor(() => expect(ack).toHaveBeenCalledOnce());
      expect(ack).toHaveBeenCalledOnce();
      expect(fail).not.toHaveBeenCalled();
      await worker.close();
    } finally {
      vi.useRealTimers();
    }
  });

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

  it('closes admission while a due settlement retry drains its current generation', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'flows-shared-node-runtime-reconcile-barrier-'));
    roots.push(dataDir);
    const pending = dispatch('edit-after-drain', 'dispatch_afterdrain');
    let spawnedName = '';
    const spawn = vi.fn<NodeSpawnPort['spawn']>(async input => {
      spawnedName = input.name;
      return { id: 'spawn_after_drain', action: 'spawn', status: 'completed',
        nodeId: 'node_1', nodeName: 'desktop-1', name: input.name, agentId: 'agent_after_drain',
        spawned: true, ready: true };
    });
    const runtime: NodeSpawnRuntime = {
      publisher: { id: 'publisher_1', name: 'flows-publisher' },
      baseUrl: 'https://cast.agentrelay.com',
      port: {
        targets: async () => [],
        spawn,
        status: vi.fn(),
        release: vi.fn<NodeSpawnPort['release']>(async () => ({
          id: 'release_after_drain', action: 'release', status: 'completed',
          spawned: false, ready: false, released: true,
        })),
      },
      inbox: { inbox: {
        subscribe: async function* () {
          yield { id: 'delivery_after_drain', message: { id: 'message_after_drain',
            from: { id: 'agent_after_drain', name: spawnedName },
            text: NODE_RESULT_PREFIX + JSON.stringify({ version: 1, run_id: pending.run_id,
              step_id: pending.step_id, dispatch_id: pending.idempotency_key,
              status: 'completed', output: { step: pending.step_id } }) } };
        },
        ack: vi.fn(async () => ({})),
        fail: vi.fn(async () => ({})),
      } },
    };
    owner.get.mockResolvedValue(runtime);
    const stepHeartbeat = vi.fn(async () => ({ lease_deadline_ms: Date.now() + 30_000 }));
    const client = Object.assign(new EventEmitter(), {
      workerAttach: vi.fn(async () => ({})),
      stepHeartbeat,
      stepComplete: vi.fn(async () => ({})),
      supportsFeature: vi.fn(() => true),
    });
    const worker = new AgentWorker(client as unknown as JournalClient, {
      workerId: 'worker_reconcile_barrier', pins: {}, dataDir,
    });
    const errors: unknown[] = [];
    worker.on('error', error => errors.push(error));
    await worker.attach();

    const state = worker as unknown as {
      inFlight: Set<Promise<void>>;
      reconcileRelaySettlementsAfterDrain(): Promise<void>;
    };
    let finishCurrentGeneration!: () => void;
    const currentGeneration = new Promise<void>(resolve => { finishCurrentGeneration = resolve; });
    state.inFlight.add(currentGeneration);
    const reconciliation = state.reconcileRelaySettlementsAfterDrain();
    client.emit('step.dispatch', pending);
    await Promise.resolve();
    await Promise.resolve();
    expect(stepHeartbeat).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();

    const closing = worker.close();
    state.inFlight.delete(currentGeneration);
    finishCurrentGeneration();
    await Promise.all([reconciliation, closing]);
    expect(errors).toEqual([]);
    expect(stepHeartbeat).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledOnce();
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
