import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { classifyOutcome, emptyReport } from '../src/cli/run.js';
import type { JournalClient } from '../src/journal-client.js';

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date', 'performance'] });
  const deadline = Date.now() - 1;
  const snapshot = (state: string, lease = deadline) => ({
    run_id: 'run', status: 'parked',
    steps: { answer: { type: 'llm', state, lease_deadline_ms: lease } },
    budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
  });
  const parked = { run_id: 'run', status: 'parked' as const, completion_reason: null, completed_steps: 0 };
  const client = {
    createPeer: () => Object.assign(new EventEmitter(), {
      connect: async () => {}, hello: async () => {}, runWatch: async () => {}, close: () => {},
    }),
    runGet: vi.fn().mockResolvedValue(snapshot('running')),
    runResume: vi.fn().mockResolvedValue(parked),
  };
  const run = () => classifyOutcome(client as unknown as JournalClient, 'run', parked, emptyReport('run'), '', {});
  return { client, snapshot, run };
}

it('waits through an expired snapshot until the kernel retries and completes', async () => {
  const { client, snapshot, run } = fixture();
  client.runGet.mockResolvedValueOnce(snapshot('running'))
    .mockResolvedValueOnce(snapshot('runnable'))
    .mockResolvedValueOnce(snapshot('running', Date.now() + 30_000))
    .mockResolvedValue(snapshot('completed'));
  client.runResume.mockResolvedValueOnce({ run_id: 'run', status: 'parked', completion_reason: null, completed_steps: 0 })
    .mockResolvedValue({ run_id: 'run', status: 'completed', completion_reason: 'success', completed_steps: 1 });
  const execution = run();
  const assertion = expect(execution).resolves.toMatchObject({ exitCode: 0, report: { completionReason: 'success' } });
  await Promise.all([assertion, vi.advanceTimersByTimeAsync(4_000)]);
  expect(client.runResume).toHaveBeenCalledTimes(2);
});

it('still fails when the kernel never resolves an expired lease after sweep grace', async () => {
  const { run } = fixture();
  const assertion = expect(run()).rejects.toThrow('without completion');
  await vi.advanceTimersByTimeAsync(36_500);
  await assertion;
});

it('bounds an unchanged lease when the CLI clock is behind the daemon', async () => {
  const { client, snapshot, run } = fixture();
  client.runGet.mockResolvedValue(snapshot('running', Date.now() + 75_000));
  const assertion = expect(run()).rejects.toThrow('without completion');
  await vi.advanceTimersByTimeAsync(36_500);
  await assertion;
});

it('follows a live step whose renewed deadline looks expired on a skewed CLI clock', async () => {
  // The CLI's wall clock runs 60s ahead of the daemon: every deadline the
  // worker renews reads as already past here. It used to throw
  // `expired ... without completion` five seconds in, abandoning a healthy
  // attempt; the moving deadline is what says it is alive.
  const { client, snapshot, run } = fixture();
  let renewed = Date.now() - 60_000;
  client.runGet.mockImplementation(async () => {
    renewed += 250;
    return snapshot('running', renewed);
  });
  const execution = run();
  let settled = false;
  void execution.then(() => { settled = true; }, () => { settled = true; });
  await vi.advanceTimersByTimeAsync(60_000);
  expect(settled).toBe(false);
  client.runGet.mockResolvedValue(snapshot('completed'));
  client.runResume.mockResolvedValue({ run_id: 'run', status: 'completed', completion_reason: 'success', completed_steps: 1 });
  const assertion = expect(execution).resolves.toMatchObject({ exitCode: 0, report: { completionReason: 'success' } });
  await Promise.all([assertion, vi.advanceTimersByTimeAsync(4_000)]);
});
