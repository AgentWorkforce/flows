import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JournalClient } from '../src/journal-client.js';
import type { NodeSpawnRuntime } from '../src/node-spawn-runtime.js';
import type { NodeSpawnPort, NodeSpawnReceipt } from '../src/node-spawn.js';
import type { StepDispatchEvent } from '../src/protocol.js';
import { AgentWorker } from '../src/worker.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

function dispatch(stepId: string, idempotencyKey: string, timeoutMs: number): StepDispatchEvent {
  return {
    run_id: 'run_timeout', step_id: stepId, attempt: 1, step_type: 'agent',
    spec: { cli: 'codex', instruction: 'Implement the change', transport: 'relay',
      timeout_ms: timeoutMs },
    idempotency_key: idempotencyKey, lease_id: `lease_${stepId}`,
    lease_deadline_ms: Date.now() + 30_000, pins: {},
  };
}

function client(stepComplete: JournalClient['stepComplete']): JournalClient & EventEmitter {
  return Object.assign(new EventEmitter(), {
    workerAttach: vi.fn(async () => ({})),
    stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 30_000 })),
    stepComplete,
    supportsFeature: vi.fn(() => true),
  }) as unknown as JournalClient & EventEmitter;
}

function runtime(spawn: NodeSpawnPort['spawn']): NodeSpawnRuntime {
  return {
    authority: 'remote', publisher: { id: 'publisher_1', name: 'flows-publisher' },
    baseUrl: 'https://cast.agentrelay.com',
    port: { targets: async () => [], spawn, status: vi.fn(), release: vi.fn() },
    inbox: { inbox: {
      subscribe: async function* () { return; },
      ack: vi.fn(async () => ({})), fail: vi.fn(async () => ({})),
    } },
  };
}

describe('AgentWorker relay deadlines', () => {
  it('carries an admitted journal timeout into the native node-spawn deadline', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'flows-node-worker-timeout-'));
    roots.push(dataDir);
    const declaredTimeoutMs = 5_000;
    const spawn = vi.fn<NodeSpawnPort['spawn']>(async () => {
      throw new Error('stop after observing timeout');
    });
    const stepComplete = vi.fn<JournalClient['stepComplete']>(async () => (
      {} as Awaited<ReturnType<JournalClient['stepComplete']>>
    ));
    const journal = client(stepComplete);
    const worker = new AgentWorker(journal, {
      workerId: 'worker_timeout', pins: {}, dataDir, nodeSpawnRuntime: runtime(spawn),
    });
    await worker.attach();
    journal.emit('step.dispatch', dispatch('edit-timeout', 'dispatch_timeout000', declaredTimeoutMs));
    await vi.waitFor(() => expect(stepComplete).toHaveBeenCalledOnce());
    await worker.close();

    expect(spawn).toHaveBeenCalledOnce();
    const observedTimeoutMs = spawn.mock.calls[0]![0].timeoutMs;
    expect(observedTimeoutMs).toBeGreaterThan(0);
    expect(observedTimeoutMs).toBeLessThanOrEqual(declaredTimeoutMs);
  });

  it('journals a native node-spawn deadline as timeout rather than worker_error', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'flows-node-worker-timeout-reason-'));
    roots.push(dataDir);
    const spawn = vi.fn<NodeSpawnPort['spawn']>(
      () => new Promise<NodeSpawnReceipt>(() => undefined));
    const stepComplete = vi.fn<JournalClient['stepComplete']>(async () => (
      {} as Awaited<ReturnType<JournalClient['stepComplete']>>
    ));
    const journal = client(stepComplete);
    const worker = new AgentWorker(journal, {
      workerId: 'worker_timeout_reason', pins: {}, dataDir, nodeSpawnRuntime: runtime(spawn),
    });
    await worker.attach();
    journal.emit('step.dispatch', dispatch('edit-timeout-reason', 'dispatch_timeout001', 100));
    await vi.waitFor(() => expect(stepComplete).toHaveBeenCalledOnce());
    await worker.close();

    expect(stepComplete).toHaveBeenCalledWith(
      'run_timeout', 'edit-timeout-reason', 1, 'dispatch_timeout001', 'timeout',
      expect.objectContaining({ trajectory_tail: expect.objectContaining({
        transport: expect.objectContaining({ phase: 'timeout', cause: 'timeout', retryable: false }),
      }) }),
    );
  });
});
