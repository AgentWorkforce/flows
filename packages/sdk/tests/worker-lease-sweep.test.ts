import { afterEach, expect, it, vi } from 'vitest';
import { classifyOutcome, emptyReport } from '../src/cli/run.js';
import type { JournalClient } from '../src/journal-client.js';

afterEach(() => vi.useRealTimers());

function fixture() {
  vi.useFakeTimers();
  const deadline = Date.now() - 1;
  const snapshot = (state: string, lease = deadline) => ({
    run_id: 'run', status: 'parked',
    steps: { answer: { type: 'llm', state, lease_deadline_ms: lease } },
    budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
  });
  const parked = { run_id: 'run', status: 'parked' as const, completion_reason: null, completed_steps: 0 };
  const client = {
    runGet: vi.fn().mockResolvedValue(snapshot('running')),
    runResume: vi.fn().mockResolvedValue(parked),
  };
  const run = () => classifyOutcome(client as unknown as JournalClient, 'run', parked, emptyReport('run'), '/unused', {});
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
  await Promise.all([assertion, vi.advanceTimersByTimeAsync(100)]);
  expect(client.runResume).toHaveBeenCalledTimes(2);
});

it('still fails when the kernel never resolves an expired lease after sweep grace', async () => {
  const { run } = fixture();
  const assertion = expect(run()).rejects.toThrow('without completion');
  await vi.advanceTimersByTimeAsync(5_001);
  await assertion;
});
