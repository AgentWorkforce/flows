import { EventEmitter } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runAgentRelayTask, type AgentRelayTaskRequest } from '../src/agent-relay-transport.js';
import type { JournalClient } from '../src/journal-client.js';
import { NODE_RESULT_PREFIX } from '../src/node-spawn-result.js';
import type { NodeSpawnRuntime } from '../src/node-spawn-runtime.js';
import { readNodeSpawnClaims, recordNodeSpawn } from '../src/node-spawn-state.js';
import { NodeSpawnError, type NodeSpawnPort, type NodeSpawnReceipt } from '../src/node-spawn.js';
import type { StepDispatchEvent } from '../src/protocol.js';
import { AgentWorker } from '../src/worker.js';

const request = (dataDir: string): AgentRelayTaskRequest => ({
  cli: 'codex', task: 'Implement the change', runId: 'run_1', stepId: 'edit',
  idempotencyKey: 'dispatch_1234567890', attempt: 1, dataDir, timeoutMs: 10_000,
});

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function dataDirectory(label: string): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), label));
  roots.push(directory);
  return directory;
}

function fixture(): { runtime: NodeSpawnRuntime; spawn: ReturnType<typeof vi.fn>;
  release: ReturnType<typeof vi.fn>; ack: ReturnType<typeof vi.fn>; fail: ReturnType<typeof vi.fn> } {
  const receipt: NodeSpawnReceipt = {
    id: 'inv_spawn_1', action: 'spawn', status: 'completed', nodeId: 'node_1', nodeName: 'desktop-1',
    name: 'placeholder', agentId: 'agent_1', spawned: true, ready: true,
  };
  const spawn = vi.fn(async (input: { name: string }) => ({ ...receipt, name: input.name }));
  const release = vi.fn(async () => ({ id: 'inv_release_1', action: 'release' as const,
    status: 'completed' as const, spawned: false, ready: false, released: true }));
  const ack = vi.fn(async () => ({}));
  const fail = vi.fn(async () => ({}));
  const port: NodeSpawnPort = {
    targets: async () => [], spawn,
    status: vi.fn(async () => ({ ...receipt })),
    release,
  };
  const runtime: NodeSpawnRuntime = {
    port,
    publisher: { id: 'publisher_1', name: 'flows-publisher' },
    baseUrl: 'https://cast.agentrelay.com',
    inbox: { inbox: {
      subscribe: async function* () {
        const name = (await spawn.mock.results[0]!.value).name;
        yield { id: 'delivery_1', message: { id: 'message_1',
          from: { id: 'agent_1', name },
          text: NODE_RESULT_PREFIX + JSON.stringify({ version: 1, run_id: 'run_1',
            step_id: 'edit', dispatch_id: 'dispatch_1234567890', status: 'completed',
            output: { summary: 'done' } }) } };
      },
      ack,
      fail,
    } },
  };
  return { runtime, spawn, release, ack, fail };
}

function journaledRelayResult(): Record<string, unknown> {
  return {
    completionReason: 'success',
    trajectory_tail: { relay_task: { task_execution: {
      run_id: 'run_1', step_id: 'edit', dispatch_id: 'dispatch_1234567890',
      delivery_id: 'delivery_1', message_id: 'message_1',
    } } },
  };
}

function terminalEntry(payload: Record<string, unknown> = journaledRelayResult()) {
  return {
    seq: 2, segment_id: 0, entry_type: 'step.completed', run_id: 'run_1',
    step_id: 'edit', attempt: 1, at_ms: Date.now(), payload,
  };
}

describe('durable node-result settlement', () => {
  it('carries the observed teardown barrier through durable settlement', async () => {
    const dataDir = await dataDirectory('flows-node-settlement-teardown-barrier-');
    const f = fixture();
    const order: string[] = [];
    let finishClose!: () => void;
    const closeGate = new Promise<void>(resolve => { finishClose = resolve; });
    let reportClosed!: (value: { failure?: unknown }) => void;
    const settlementReady = new Promise<{ failure?: unknown }>(resolve => { reportClosed = resolve; });
    let delivered = false;
    f.runtime.inbox.inbox.subscribe = () => ({ [Symbol.asyncIterator]() {
      return {
        async next() {
          if (delivered) return new Promise<IteratorResult<never>>(() => undefined);
          delivered = true;
          const name = (await f.spawn.mock.results[0]!.value).name;
          return { done: false as const, value: {
            id: 'delivery_1', settlementReady,
            message: { id: 'message_1', from: { id: 'agent_1', name },
              text: NODE_RESULT_PREFIX + JSON.stringify({ version: 1, run_id: 'run_1',
                step_id: 'edit', dispatch_id: 'dispatch_1234567890', status: 'completed',
                output: { summary: 'done' } }) },
          } };
        },
        async return() {
          order.push('inbox.close');
          await closeGate;
          order.push('caller.disconnect');
          reportClosed({});
          return { done: true as const, value: undefined };
        },
      };
    } });
    f.ack.mockImplementation(async () => { order.push('settle'); return {}; });

    const received = await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    await vi.waitFor(() => expect(order).toEqual(['inbox.close']));
    await received.delivery.prepareSettlement!({ attempt: 1, completionReason: 'success' });
    const settling = received.delivery.ack();
    await Promise.resolve();
    expect(f.ack).not.toHaveBeenCalled();
    finishClose();
    await settling;
    expect(order).toEqual(['inbox.close', 'caller.disconnect', 'settle']);
  });

  it('bounds an observed teardown that never settles before opening settlement', async () => {
    const dataDir = await dataDirectory('flows-node-settlement-teardown-timeout-');
    const f = fixture();
    let delivered = false;
    const settlementReady = new Promise<{ failure?: unknown }>(() => undefined);
    f.runtime.inbox.inbox.subscribe = () => ({ [Symbol.asyncIterator]() {
      return {
        async next() {
          if (delivered) return new Promise<IteratorResult<never>>(() => undefined);
          delivered = true;
          const name = (await f.spawn.mock.results[0]!.value).name;
          return { done: false as const, value: {
            id: 'delivery_1', settlementReady,
            message: { id: 'message_1', from: { id: 'agent_1', name },
              text: NODE_RESULT_PREFIX + JSON.stringify({ version: 1, run_id: 'run_1',
                step_id: 'edit', dispatch_id: 'dispatch_1234567890', status: 'completed',
                output: { summary: 'done' } }) },
          } };
        },
        return: () => new Promise<IteratorResult<never>>(() => undefined),
      };
    } });

    const received = await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    await received.delivery.prepareSettlement!({ attempt: 1, completionReason: 'success' });
    vi.useFakeTimers();
    try {
      const settlement = expect(received.delivery.ack())
        .rejects.toMatchObject({ code: 'result_settlement_unconfirmed' });
      await vi.advanceTimersByTimeAsync(10_001);
      await settlement;
      expect(f.ack).not.toHaveBeenCalled();
      expect(f.fail).not.toHaveBeenCalled();
      const claims = await readNodeSpawnClaims(dataDir);
      expect(claims[0]!.claim.result?.settlement).not.toHaveProperty('settledAt');
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects an invalid resolved spawn receipt before reading the inbox and releases exact identity', async () => {
    const dataDir = await dataDirectory('flows-node-invalid-resolved-spawn-');
    const f = fixture();
    f.spawn.mockImplementationOnce(async (input: { name: string }) => ({
      id: 'inv_spawn_1', action: 'spawn', status: 'completed', nodeId: 'node_1', nodeName: 'desktop-1',
      name: input.name, agentId: 'agent_1', spawned: true, ready: false,
    }) as never);
    f.runtime.inbox.inbox.subscribe = async function* () { throw new Error('inbox must not be read'); };
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime }))
      .rejects.toThrow('valid ready identity');
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('refuses malformed cleanup identity from a custom port without issuing a release', async () => {
    const dataDir = await dataDirectory('flows-node-malformed-cleanup-');
    const f = fixture();
    f.spawn.mockRejectedValueOnce(new NodeSpawnError('custom port failed',
      'spawn_unconfirmed', undefined, { id: 'inv_spawn_1' } as never));
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime }))
      .rejects.toThrow('custom port failed');
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime }))
      .rejects.toThrow('ambiguous pre-ack');
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.release).not.toHaveBeenCalled();
  });

  it('rejects a resolved but unconfirmed release and keeps the result unacked', async () => {
    const dataDir = await dataDirectory('flows-node-cleanup-negative-receipt-');
    const f = fixture();
    f.release.mockResolvedValueOnce({ id: 'inv_release_1', action: 'release', status: 'failed',
      spawned: true, ready: true, released: false, errorCode: 'release_refused' });
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime }))
      .rejects.toMatchObject({ cleanupPending: true });
    expect(f.ack).not.toHaveBeenCalled();
    const [claim] = await readNodeSpawnClaims(dataDir);
    expect(claim!.claim.cleanupPending).toMatchObject({ attempts: 1, lastError: expect.any(String) });
    expect(claim!.claim.release).toBeUndefined();
  });

  it('fails closed on an incomplete durable result instead of replaying or spawning', async () => {
    const dataDir = await dataDirectory('flows-node-invalid-claim-');
    const f = fixture();
    await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    const [entry] = await readNodeSpawnClaims(dataDir);
    const result = entry!.claim.result!;
    const { envelope: _envelope, ...incomplete } = result;
    await recordNodeSpawn(entry!.path, { ...entry!.claim,
      result: incomplete as unknown as typeof result });
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime }))
      .rejects.toThrow('Invalid durable node-spawn claim');
    expect(f.spawn).toHaveBeenCalledOnce();
  });

  it('fails closed on a corrupt durable spawn identity before attempting release', async () => {
    const dataDir = await dataDirectory('flows-node-invalid-spawn-');
    const f = fixture();
    await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    const [entry] = await readNodeSpawnClaims(dataDir);
    const spawn = entry!.claim.spawn!;
    const { agentId: _agentId, ...incomplete } = spawn;
    await recordNodeSpawn(entry!.path, { ...entry!.claim,
      spawn: incomplete as unknown as typeof spawn, release: undefined });
    f.release.mockClear();
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime }))
      .rejects.toThrow('Invalid durable node-spawn claim');
    expect(f.release).not.toHaveBeenCalled();
  });

  it('fails closed on an unconfirmed durable release before replaying a result', async () => {
    const dataDir = await dataDirectory('flows-node-invalid-release-');
    const f = fixture();
    await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    const [entry] = await readNodeSpawnClaims(dataDir);
    await recordNodeSpawn(entry!.path, { ...entry!.claim,
      release: { ...entry!.claim.release!, status: 'failed' } });
    f.release.mockClear();
    await expect(runAgentRelayTask(request(dataDir), { runtime: f.runtime }))
      .rejects.toThrow('Invalid durable node-spawn claim');
    expect(f.release).not.toHaveBeenCalled();
  });

  it('reconciles a journaled result left unacked by a crashed worker', async () => {
    const dataDir = await dataDirectory('flows-node-settlement-crash-');
    const f = fixture();
    const received = await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    await received.delivery.prepareSettlement!({ attempt: 1, completionReason: 'success' });
    const client = Object.assign(new EventEmitter(), {
      workerAttach: vi.fn(async () => ({})),
      journalRead: vi.fn(async () => ({ entries: [terminalEntry()] })),
    });
    const worker = new AgentWorker(client as unknown as JournalClient, {
      workerId: 'worker_recovery', pins: {}, dataDir, nodeSpawnRuntime: f.runtime,
    });
    await worker.attach();
    expect(f.ack).toHaveBeenCalledOnce();
    const claims = await readNodeSpawnClaims(dataDir);
    expect(claims[0]!.claim.result?.settlement).toMatchObject({ settledAs: 'ack' });
    await worker.close();
  });

  it('finds a terminal relay result beyond the first journal page before acknowledging', async () => {
    const dataDir = await dataDirectory('flows-node-settlement-paged-');
    const f = fixture();
    const received = await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    await received.delivery.prepareSettlement!({ attempt: 1, completionReason: 'success' });
    const filler = Array.from({ length: 256 }, (_, index) => ({
      seq: index + 1, segment_id: 0, entry_type: 'channel.appended', run_id: 'run_1',
      step_id: null, attempt: null, at_ms: Date.now(), payload: {},
    }));
    const journalRead = vi.fn(async (_runId: string, fromSeq: number, limit?: number) => ({
      entries: fromSeq === 1 ? filler.slice(0, limit) : [{ ...terminalEntry(), seq: 257 }],
    }));
    const client = Object.assign(new EventEmitter(), {
      workerAttach: vi.fn(async () => ({})),
      journalRead,
    });
    const worker = new AgentWorker(client as unknown as JournalClient, {
      workerId: 'worker_recovery', pins: {}, dataDir, nodeSpawnRuntime: f.runtime,
    });
    await worker.attach();
    expect(journalRead).toHaveBeenNthCalledWith(1, 'run_1', 1, 256);
    expect(journalRead).toHaveBeenNthCalledWith(2, 'run_1', 257, 256);
    expect(f.ack).toHaveBeenCalledOnce();
    const claims = await readNodeSpawnClaims(dataDir);
    expect(claims[0]!.claim.result?.settlement).toMatchObject({ settledAs: 'ack' });
    await worker.close();
  });

  it('fails a delivery when the journal terminal belongs to different relay evidence', async () => {
    const dataDir = await dataDirectory('flows-node-settlement-mismatch-');
    const f = fixture();
    const received = await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    await received.delivery.prepareSettlement!({ attempt: 1, completionReason: 'success' });
    const mismatch = {
      completionReason: 'success',
      trajectory_tail: { relay_task: { task_execution: {
        delivery_id: 'different_delivery', message_id: 'different_message',
      } } },
    };
    const client = Object.assign(new EventEmitter(), {
      workerAttach: vi.fn(async () => ({})),
      journalRead: vi.fn(async () => ({ entries: [terminalEntry(mismatch)] })),
    });
    const worker = new AgentWorker(client as unknown as JournalClient, {
      workerId: 'worker_recovery', pins: {}, dataDir, nodeSpawnRuntime: f.runtime,
    });
    await worker.attach();
    expect(f.ack).not.toHaveBeenCalled();
    expect(f.fail).toHaveBeenCalledWith(expect.objectContaining({ inboxItemId: 'delivery_1', retry: false }));
    const claims = await readNodeSpawnClaims(dataDir);
    expect(claims[0]!.claim.result?.settlement).toMatchObject({ settledAs: 'fail' });
    await worker.close();
  });

  it('dead-letters matching delivery ids attached to a different dispatch', async () => {
    const dataDir = await dataDirectory('flows-node-settlement-dispatch-mismatch-');
    const f = fixture();
    const received = await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    await received.delivery.prepareSettlement!({ attempt: 1, completionReason: 'success' });
    const mismatch = journaledRelayResult();
    const trajectory = mismatch.trajectory_tail as { relay_task: { task_execution: Record<string, unknown> } };
    trajectory.relay_task.task_execution.dispatch_id = 'dispatch_different1';
    const client = Object.assign(new EventEmitter(), {
      workerAttach: vi.fn(async () => ({})),
      journalRead: vi.fn(async () => ({ entries: [terminalEntry(mismatch)] })),
    });
    const worker = new AgentWorker(client as unknown as JournalClient, {
      workerId: 'worker_recovery', pins: {}, dataDir, nodeSpawnRuntime: f.runtime,
    });
    await worker.attach();
    expect(f.ack).not.toHaveBeenCalled();
    expect(f.fail).toHaveBeenCalledOnce();
    const claims = await readNodeSpawnClaims(dataDir);
    expect(claims[0]!.claim.result?.settlement).toMatchObject({ settledAs: 'fail' });
    await worker.close();
  });

  it('retries an idempotent inbox settlement when ack preceded its durable record', async () => {
    const dataDir = await dataDirectory('flows-node-settlement-record-crash-');
    const f = fixture();
    const received = await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    await received.delivery.prepareSettlement!({ attempt: 1, completionReason: 'success' });
    await received.delivery.ack();
    const [entry] = await readNodeSpawnClaims(dataDir);
    const result = entry!.claim.result!;
    await recordNodeSpawn(entry!.path, { ...entry!.claim, result: { ...result,
      settlement: { ...result.settlement!, settledAt: undefined, settledAs: undefined } } });
    const client = Object.assign(new EventEmitter(), {
      workerAttach: vi.fn(async () => ({})),
      journalRead: vi.fn(async () => ({ entries: [terminalEntry()] })),
    });
    const worker = new AgentWorker(client as unknown as JournalClient, {
      workerId: 'worker_recovery', pins: {}, dataDir, nodeSpawnRuntime: f.runtime,
    });
    await worker.attach();
    expect(f.ack).toHaveBeenCalledTimes(2);
    await worker.close();
  });

  it('replays an unjournaled result on a later kernel attempt without another spawn', async () => {
    const dataDir = await dataDirectory('flows-node-settlement-redispatch-');
    const f = fixture();
    const first = await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    await first.delivery.prepareSettlement!({ attempt: 1, completionReason: 'success' });
    const replayed = await runAgentRelayTask({ ...request(dataDir), attempt: 2 }, { runtime: f.runtime });
    await replayed.delivery.prepareSettlement!({ attempt: 2, completionReason: 'success' });
    const claims = await readNodeSpawnClaims(dataDir);
    expect(claims[0]!.claim.result?.settlement).toMatchObject({ attempt: 2, completionReason: 'success' });
    expect(f.spawn).toHaveBeenCalledOnce();
    expect(f.release).toHaveBeenCalledOnce();
  });

  it('bounds a stalled inbox settlement and leaves its durable intent pending', async () => {
    const dataDir = await dataDirectory('flows-node-settlement-stall-');
    const f = fixture();
    const received = await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    await received.delivery.prepareSettlement!({ attempt: 1, completionReason: 'success' });
    f.ack.mockImplementationOnce(() => new Promise(() => undefined));
    vi.useFakeTimers();
    try {
      const pending = expect(received.delivery.ack())
        .rejects.toMatchObject({ code: 'result_settlement_unconfirmed' });
      await vi.advanceTimersByTimeAsync(10_001);
      await pending;
      const claims = await readNodeSpawnClaims(dataDir);
      expect(claims[0]!.claim.result?.settlement).not.toHaveProperty('settledAt');
    } finally {
      vi.useRealTimers();
    }
  });

  it('coalesces concurrent settlement callers onto one inbox operation', async () => {
    const dataDir = await dataDirectory('flows-node-settlement-coalesce-');
    const f = fixture();
    const received = await runAgentRelayTask(request(dataDir), { runtime: f.runtime });
    await received.delivery.prepareSettlement!({ attempt: 1, completionReason: 'success' });
    let confirm!: () => void;
    f.ack.mockImplementationOnce(() => new Promise<void>(resolve => { confirm = resolve; }));
    const first = received.delivery.ack();
    const second = received.delivery.ack();
    expect(first).toBe(second);
    expect(f.ack).toHaveBeenCalledOnce();
    confirm();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it('retries a rejected post-journal ack through the durable settlement outbox', async () => {
    const dataDir = await dataDirectory('flows-node-settlement-reject-');
    const f = fixture();
    f.ack.mockRejectedValueOnce(new Error('temporary inbox outage'));
    let completed = false;
    const client = Object.assign(new EventEmitter(), {
      workerAttach: vi.fn(async () => ({})),
      stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 30_000 })),
      stepComplete: vi.fn(async () => { completed = true; return {}; }),
      journalRead: vi.fn(async () => ({ entries: completed ? [terminalEntry()] : [] })),
    });
    const worker = new AgentWorker(client as unknown as JournalClient, {
      workerId: 'worker_1', pins: {}, dataDir, nodeSpawnRuntime: f.runtime,
    });
    const errors: unknown[] = [];
    worker.on('error', error => errors.push(error));
    await worker.attach();
    client.emit('step.dispatch', dispatch());
    await worker.close();
    expect(errors).toEqual([expect.objectContaining({ message: 'temporary inbox outage' })]);
    expect(f.ack).toHaveBeenCalledTimes(2);
    const claims = await readNodeSpawnClaims(dataDir);
    expect(claims[0]!.claim.result?.settlement).toMatchObject({ settledAs: 'ack' });
  });

  it('keeps retrying a journaled settlement after repeated inbox outages', async () => {
    vi.useFakeTimers();
    try {
      const dataDir = await dataDirectory('flows-node-settlement-repeat-');
      const f = fixture();
      f.ack.mockRejectedValueOnce(new Error('first inbox outage'))
        .mockRejectedValueOnce(new Error('second inbox outage'));
      let completed = false;
      const client = Object.assign(new EventEmitter(), {
        workerAttach: vi.fn(async () => ({})),
        stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 30_000 })),
        stepComplete: vi.fn(async () => { completed = true; return {}; }),
        journalRead: vi.fn(async () => ({ entries: completed ? [terminalEntry()] : [] })),
      });
      const worker = new AgentWorker(client as unknown as JournalClient, {
        workerId: 'worker_1', pins: {}, dataDir, nodeSpawnRuntime: f.runtime,
      });
      const errors: unknown[] = [];
      worker.on('error', error => errors.push(error));
      await worker.attach();
      client.emit('step.dispatch', dispatch());
      await vi.waitFor(() => expect(f.ack).toHaveBeenCalledTimes(2));
      expect(errors).toHaveLength(2);
      await vi.advanceTimersByTimeAsync(5_001);
      await vi.waitFor(() => expect(f.ack).toHaveBeenCalledTimes(3));
      const claims = await readNodeSpawnClaims(dataDir);
      expect(claims[0]!.claim.result?.settlement).toMatchObject({ settledAs: 'ack' });
      await worker.close();
    } finally {
      vi.useRealTimers();
    }
  });
});

function dispatch(): StepDispatchEvent {
  return {
    run_id: 'run_1', step_id: 'edit', attempt: 1, step_type: 'agent',
    spec: { cli: 'codex', instruction: 'Implement the change', transport: 'relay' },
    idempotency_key: 'dispatch_1234567890', lease_id: 'lease_1',
    lease_deadline_ms: Date.now() + 30_000, pins: {},
  };
}
