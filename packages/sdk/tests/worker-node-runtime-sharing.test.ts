import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { NODE_RESULT_PREFIX } from '../src/node-spawn-result.js';
import type { NodeSpawnRuntime } from '../src/node-spawn-runtime.js';
import type { NodeSpawnPort } from '../src/node-spawn.js';
import type { JournalClient } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';

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
  it('shares one publisher runtime across parallel relay steps and closes it after both journal writes', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'flows-shared-node-runtime-'));
    roots.push(dataDir);
    const dispatches = [dispatch('edit-a', 'dispatch_aaaaaaaaaa'), dispatch('edit-b', 'dispatch_bbbbbbbbbb')];
    const spawned: Array<{ name: string; agentId: string; key: string }> = [];
    const order: string[] = [];
    let bothSpawned!: () => void;
    const ready = new Promise<void>(resolve => { bothSpawned = resolve; });
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
    owner.close.mockImplementation(async () => { order.push('close'); });
    const stepComplete = vi.fn<JournalClient['stepComplete']>(async (_runId, stepId) => {
      order.push(`journal:${stepId}`);
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
    await worker.close();

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
});

function dispatch(stepId: string, idempotencyKey: string): StepDispatchEvent {
  return {
    run_id: 'run_parallel', step_id: stepId, attempt: 1, step_type: 'agent',
    spec: { cli: 'codex', model: 'codex-medium', instruction: `Implement ${stepId}`, transport: 'relay' },
    idempotency_key: idempotencyKey, lease_id: `lease_${stepId}`,
    lease_deadline_ms: Date.now() + 30_000, pins: {},
  };
}
