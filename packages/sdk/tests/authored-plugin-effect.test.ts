import { EventEmitter } from 'node:events';
import { resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { AuthoredBudget } from '../src/authored-budget.js';
import { runPluginEffect } from '../src/authored-plugin-effect.js';
import type { JournalClient } from '../src/journal-client.js';
import { invokePlugin, readPlugin } from '../src/plugin-loader.js';

vi.mock('../src/plugin-loader.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/plugin-loader.js')>(), invokePlugin: vi.fn(),
}));
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); vi.clearAllMocks(); });

function fixture() {
  vi.useFakeTimers();
  const peer = Object.assign(new EventEmitter(), {
    connect: vi.fn(async () => {}), hello: vi.fn(async () => {}), workerAttach: vi.fn(async () => {}),
    close: vi.fn(),
    performEffect: vi.fn(async (_effect, perform: () => Promise<void>) => { await perform(); return true; }),
    stepComplete: vi.fn(async () => {}),
    stepHeartbeat: vi.fn(async () => ({ lease_deadline_ms: Date.now() + 60_000 })),
  });
  const started = Promise.withResolvers<any>();
  const journal = {
    createPeer: () => peer,
    runStart: vi.fn(async (spec: any) => { started.resolve(spec); return { run_id: 'plugin-run' }; }),
    runCancel: vi.fn(async () => {}),
    journalRead: vi.fn(async () => ({ entries: [{ entry_type: 'step.completed', step_id: 'plugin-1',
      payload: { completionReason: 'success', output: { type: 'effect', output: { ok: true } } } }] })),
  };
  const plugin = readPlugin(resolve('../../testdata/plugins/helper-datadog'), '@flows/helper-datadog');
  const run = () => runPluginEffect(journal as unknown as JournalClient, 'test', 'plugin-1', plugin,
    plugin.manifest.verbs[0]!, {}, [], new AuthoredBudget(undefined));
  return { peer, journal, started, run };
}

it.each(['connect', 'hello', 'workerAttach'] as const)('bounds a stalled %s handshake and stops setup after timeout', async stage => {
  const f = fixture();
  const stalled = Promise.withResolvers<void>();
  f.peer[stage].mockReturnValue(stalled.promise);
  const rejected = expect(f.run()).rejects.toThrow('dispatch deadline exceeded');
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  expect(f.peer[stage]).toHaveBeenCalledTimes(1);
  expect(f.peer.close).toHaveBeenCalledTimes(1);
  stalled.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(f.journal.runStart).not.toHaveBeenCalled();
  expect(f.peer.listenerCount('step.dispatch')).toBe(0);
  expect(invokePlugin).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});

it('includes initialization in the dispatch deadline and cancels the child run', async () => {
  const f = fixture();
  const initialized = Promise.withResolvers<void>();
  f.peer.hello.mockReturnValue(initialized.promise);
  const rejected = expect(f.run()).rejects.toThrow('dispatch deadline exceeded');
  await vi.advanceTimersByTimeAsync(20_000);
  initialized.resolve();
  await f.started.promise;
  await vi.advanceTimersByTimeAsync(9_999);
  expect(f.peer.close).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await rejected;
  expect(f.journal.runCancel).toHaveBeenCalledTimes(1);
  expect(f.journal.runCancel).toHaveBeenCalledWith('plugin-run');
  expect(f.peer.close).toHaveBeenCalledTimes(1);
});

it('bounds run creation and cancels a child whose run.start response arrives after timeout', async () => {
  const f = fixture();
  const outcome = Promise.withResolvers<{ run_id: string }>();
  f.journal.runStart.mockImplementation(async spec => { f.started.resolve(spec); return outcome.promise; });
  const rejected = expect(f.run()).rejects.toThrow('dispatch deadline exceeded');
  await f.started.promise;
  await vi.advanceTimersByTimeAsync(30_000);
  await rejected;
  expect(f.peer.close).toHaveBeenCalledTimes(1);
  expect(f.journal.runCancel).not.toHaveBeenCalled();
  outcome.resolve({ run_id: 'plugin-run' });
  await vi.advanceTimersByTimeAsync(0);
  expect(f.journal.runCancel).toHaveBeenCalledTimes(1);
  expect(f.journal.runCancel).toHaveBeenCalledWith('plugin-run');
  expect(invokePlugin).not.toHaveBeenCalled();
});

it('clears the deadline on dispatch so a provider can complete after 30 seconds', async () => {
  const f = fixture();
  const provider = Promise.withResolvers<unknown>();
  vi.mocked(invokePlugin).mockReturnValue(provider.promise);
  const running = f.run();
  const spec = await f.started.promise;
  await vi.advanceTimersByTimeAsync(29_000);
  f.peer.emit('step.dispatch', {
    run_id: 'plugin-run', step_id: 'plugin-1', step_type: 'agent', spec: spec.steps[0],
    attempt: 1, idempotency_key: 'kernel-key', pins: {},
    lease_deadline_ms: Date.now() + 45_000, lease_id: 'lease-plugin-1',
  });
  try {
    await vi.advanceTimersByTimeAsync(2_000);
    expect(invokePlugin).toHaveBeenCalledTimes(1);
    expect(f.peer.close).not.toHaveBeenCalled();
    provider.resolve({ ok: true });
    await expect(running).resolves.toEqual({ ok: true });
    expect(f.peer.stepComplete).toHaveBeenCalledTimes(1);
    expect(f.journal.runCancel).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  } finally {
    provider.resolve({ ok: true });
    await running.catch(() => undefined);
  }
});
