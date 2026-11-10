import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { JournalClient } from '../src/journal-client.js';
import type { NodeSpawnRuntime } from '../src/node-spawn-runtime.js';
import { readNodeSpawnClaims } from '../src/node-spawn-state.js';
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
    port: { dispatchFenceVersion: 1, targets: async () => [], spawn, status: vi.fn(), release: vi.fn() },
    inbox: { inbox: {
      subscribe: async function* () { return; },
      ack: vi.fn(async () => ({})), fail: vi.fn(async () => ({})),
    } },
  };
}

async function waitForImmediate(assertion: () => void | Promise<void>): Promise<void> {
  let failure: unknown;
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      await assertion();
      return;
    } catch (error) {
      failure = error;
      await new Promise<void>(resolve => setImmediate(resolve));
    }
  }
  throw failure;
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
    const spawn = vi.fn<NodeSpawnPort['spawn']>(async (_input, beforeDispatch) => {
      await beforeDispatch();
      return new Promise<NodeSpawnReceipt>(() => undefined);
    });
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

  it('durably retries failed exact cleanup after a late confirmation and terminal timeout', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'flows-node-worker-late-cleanup-'));
    roots.push(dataDir);
    let confirm!: (receipt: NodeSpawnReceipt) => void;
    const spawn = vi.fn<NodeSpawnPort['spawn']>(async (input, beforeDispatch) => {
      await beforeDispatch();
      return new Promise<NodeSpawnReceipt>(resolve => {
        confirm = receipt => resolve({ ...receipt, name: input.name });
      });
    });
    const release = vi.fn<NodeSpawnPort['release']>()
      .mockRejectedValueOnce(new Error('release response temporarily unavailable'))
      .mockResolvedValueOnce({
        id: 'inv_release_late', action: 'release', status: 'completed',
        spawned: false, ready: false, released: true,
      });
    const nodeRuntime: NodeSpawnRuntime = {
      authority: 'remote', publisher: { id: 'publisher_1', name: 'flows-publisher' },
      baseUrl: 'https://cast.agentrelay.com',
      port: {
        dispatchFenceVersion: 1, targets: async () => [], spawn,
        status: vi.fn(), release,
      },
      inbox: { inbox: {
        subscribe: async function* () { return; },
        ack: vi.fn(async () => ({})), fail: vi.fn(async () => ({})),
      } },
    };
    const stepComplete = vi.fn<JournalClient['stepComplete']>(async () => (
      {} as Awaited<ReturnType<JournalClient['stepComplete']>>
    ));
    const journal = client(stepComplete);
    journal.journalRead = vi.fn(async () => {
      throw new Error('cleanup-only reconciliation must not read the journal');
    });
    const worker = new AgentWorker(journal, {
      workerId: 'worker_late_cleanup', pins: {}, dataDir, nodeSpawnRuntime: nodeRuntime,
    });
    const errors: unknown[] = [];
    worker.on('error', error => errors.push(error));
    await worker.attach();
    journal.emit('step.dispatch', dispatch('edit-late-cleanup', 'dispatch_latecleanup1', 50));
    await vi.waitFor(() => expect(stepComplete).toHaveBeenCalledOnce());
    expect(stepComplete).toHaveBeenCalledWith(
      'run_timeout', 'edit-late-cleanup', 1, 'dispatch_latecleanup1', 'timeout', expect.any(Object),
    );

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      confirm({
        id: 'inv_spawn_late', action: 'spawn', status: 'completed',
        nodeId: 'node_1', nodeName: 'desktop-1', name: 'placeholder',
        agentId: 'agent_late', spawned: true, ready: true,
      });
      let pending: Awaited<ReturnType<typeof readNodeSpawnClaims>>[number] | undefined;
      await waitForImmediate(async () => {
        expect(release).toHaveBeenCalledOnce();
        [pending] = await readNodeSpawnClaims(dataDir);
        expect(pending!.claim).toMatchObject({
          cleanupPending: { attempts: 1, lastError: 'release response temporarily unavailable' },
        });
      });
      expect(pending!.claim.result).toBeUndefined();
      expect(pending!.claim.release).toBeUndefined();

      await waitForImmediate(() => expect(vi.getTimerCount()).toBeGreaterThan(0));
      await vi.advanceTimersByTimeAsync(5_001);
      let reconciled: Awaited<ReturnType<typeof readNodeSpawnClaims>>[number] | undefined;
      await waitForImmediate(async () => {
        expect(release).toHaveBeenCalledTimes(2);
        [reconciled] = await readNodeSpawnClaims(dataDir);
        expect(reconciled!.claim.release).toEqual({
          invocationId: 'inv_release_late', status: 'completed',
        });
      });
      expect(reconciled!.claim.cleanupPending).toBeUndefined();
      expect(stepComplete).toHaveBeenCalledOnce();
      expect(spawn).toHaveBeenCalledOnce();
      expect(journal.journalRead).not.toHaveBeenCalled();
      expect(errors).toEqual([]);
    } finally {
      vi.useRealTimers();
      await worker.close();
    }
  });
});
