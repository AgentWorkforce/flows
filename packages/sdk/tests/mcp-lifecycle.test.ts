import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { runMcpEffect } from '../src/authored-mcp.js';
import { openMcpSession } from '../src/mcp-client.js';
import type { JournalClient } from '../src/journal-client.js';

vi.mock('../src/mcp-client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/mcp-client.js')>(), openMcpSession: vi.fn(),
}));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

function fixture() {
  const peer = Object.assign(new EventEmitter(), {
    connect: vi.fn(async () => {}), hello: vi.fn(async () => {}), workerAttach: vi.fn(async () => {}),
    close: vi.fn(),
    performEffect: vi.fn(async (_effect, perform: () => Promise<void>) => { await perform(); return true; }),
    stepComplete: vi.fn(async () => {}),
    // withWorkerLease renews the lease periodically; give a moving deadline far
    // enough ahead that the fake-timer tests never trip it on their own.
    stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 60_000 })),
  });
  const started = Promise.withResolvers<any>();
  const journal = {
    createPeer: () => peer,
    runStart: vi.fn(async (spec: any) => { started.resolve(spec); return { run_id: 'mcp-run' }; }),
    runCancel: vi.fn(async () => ({ run_id: 'mcp-run', state: 'canceled' as const })),
    journalRead: vi.fn(async () => ({ entries: [{ entry_type: 'step.completed', step_id: 'mcp-1',
      payload: { completionReason: 'success', output: { type: 'mcp', output: { ok: true } } } }] })),
  };
  const run = () => runMcpEffect(journal as unknown as JournalClient, 'test', 'mcp-1', 'foo', 'echo', {}, true, { command: 'unused' }, []);
  return { peer, journal, started, run };
}

it('clears the dispatch deadline before a late valid dispatch starts its provider call', async () => {
  vi.useFakeTimers();
  const provider = Promise.withResolvers<unknown>();
  const callTool = vi.fn(() => provider.promise);
  const close = vi.fn(async () => {});
  vi.mocked(openMcpSession).mockResolvedValue({ callTool, close, listTools: vi.fn() });
  const f = fixture();
  const running = f.run();
  const spec = await f.started.promise;
  await vi.advanceTimersByTimeAsync(29_000);
  f.peer.emit('step.dispatch', {
    run_id: 'mcp-run', step_id: 'mcp-1', step_type: 'agent', spec: spec.steps[0],
    attempt: 1, idempotency_key: 'kernel-key', pins: {},
    lease_deadline_ms: Date.now() + 45_000, lease_id: 'lease-mcp-1',
  });
  try {
    await vi.advanceTimersByTimeAsync(2_000);
    expect(callTool).toHaveBeenCalledTimes(1);
    expect(f.peer.close).not.toHaveBeenCalled();
    provider.resolve({ ok: true });
    await expect(running).resolves.toEqual({ ok: true });
    expect(f.peer.stepComplete).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledTimes(1);
  } finally {
    provider.resolve({ ok: true });
    await running.catch(() => undefined);
  }
});

it('bounds dispatch even when run.start never answers and performs no provider effect', async () => {
  vi.useFakeTimers();
  const f = fixture();
  f.journal.runStart.mockImplementation(async (spec: any) => {
    f.started.resolve(spec); return new Promise<never>(() => {});
  });
  const running = f.run();
  const rejected = expect(running).rejects.toThrow('dispatch deadline exceeded');
  await f.started.promise;
  await vi.advanceTimersByTimeAsync(30_001);
  await rejected;
  expect(f.peer.close).toHaveBeenCalledTimes(1);
  expect(openMcpSession).not.toHaveBeenCalled();
});

it('cancels the orphaned child run when the dispatch deadline fires after run.start resolved', async () => {
  vi.useFakeTimers();
  const f = fixture();
  const running = f.run();
  const rejected = expect(running).rejects.toThrow('dispatch deadline exceeded');
  await f.started.promise; // run.start already returned run_id 'mcp-run'
  await vi.advanceTimersByTimeAsync(30_001); // dispatch never arrives -> deadline fires
  await rejected;
  expect(f.journal.runCancel).toHaveBeenCalledTimes(1);
  expect(f.journal.runCancel).toHaveBeenCalledWith('mcp-run');
  expect(f.peer.close).toHaveBeenCalledTimes(1);
});

it('renews the worker lease while a long-running MCP tool is in flight', async () => {
  vi.useFakeTimers();
  const provider = Promise.withResolvers<unknown>();
  const callTool = vi.fn(() => provider.promise);
  const close = vi.fn(async () => {});
  vi.mocked(openMcpSession).mockResolvedValue({ callTool, close, listTools: vi.fn() });
  const f = fixture();
  const running = f.run();
  const spec = await f.started.promise;
  // Deliver dispatch with a 30s lease so renewal must fire at least once for a 90s tool call.
  f.peer.emit('step.dispatch', {
    run_id: 'mcp-run', step_id: 'mcp-1', step_type: 'agent', spec: spec.steps[0],
    attempt: 1, idempotency_key: 'kernel-key', pins: {},
    lease_deadline_ms: Date.now() + 30_000, lease_id: 'lease-mcp-1',
  });
  try {
    // The initial armExpiry + first renew fires immediately in withWorkerLease.
    // withWorkerLease schedules the next renewal at ~1/3 of the remaining deadline.
    // Let one full round pass, then confirm heartbeat was invoked at least once
    // beyond the initial establishment renew.
    await vi.advanceTimersByTimeAsync(45_000);
    expect(f.peer.stepHeartbeat).toHaveBeenCalled();
    // Multiple heartbeats within 45s proves lease is being actively renewed.
    expect(f.peer.stepHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(2);
    provider.resolve({ ok: true });
    await expect(running).resolves.toEqual({ ok: true });
  } finally {
    provider.resolve({ ok: true });
    await running.catch(() => undefined);
  }
});
