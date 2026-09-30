import { afterEach, describe, expect, it, vi } from 'vitest';
import { readCompletedStepOutput } from '../src/authored-step-output.js';
import type { AuthoredFlowJournalStep } from '../src/authored-flow-executor.js';
import type { JournalClient } from '../src/journal-client.js';
import type { RunGetResult } from '../src/protocol.js';

type Entry = Record<string, unknown>;

const started = (attempt: number): Entry => ({
  entry_type: 'step.attempt.started', step_id: 'run-2', attempt, payload: { max_iterations: 1 },
});
const completed = (attempt: number, completionReason: string, disposition: string, output: unknown = null): Entry => ({
  entry_type: 'step.completed', step_id: 'run-2', attempt, payload: { completionReason, disposition, output },
});
const backoff = (attempt: number, wakeAtMs: number): Entry => ({
  entry_type: 'sleep.until', step_id: 'run-2', attempt,
  payload: { wait_id: `w${attempt}`, wake_at_ms: wakeAtMs, reason: 'retry_backoff' },
});
const runCompleted = (completionReason: string): Entry => ({
  entry_type: 'run.completed', payload: { completionReason },
});
const ok = { exit_code: 0, stdout_tail: 'done\n', stderr_tail: '' };

/**
 * A child run's journal as the kernel writes it, served the way `journal.read`
 * serves it (by `from_seq`). `append` adds entries while the
 * reader is waiting, as a still-driving kernel would; `snapshot` answers
 * `run.get` from whatever the journal holds at that moment.
 */
function childJournal(initial: Entry[], snapshot: (entries: Entry[]) => RunGetResult) {
  const entries: Entry[] = [];
  const append = (entry: Entry) => entries.push({ seq: entries.length + 1, run_id: 'child-1', ...entry });
  initial.forEach(append);
  const appended: unknown[] = [];
  let resumes = 0;
  const journal = {
    async journalRead(_runId: string, fromSeq: number, limit = 100) {
      return { entries: entries.filter(entry => (entry['seq'] as number) >= fromSeq).slice(0, limit) };
    },
    async runGet() { return snapshot(entries); },
    async runResume() { resumes += 1; throw new Error('the reader must not drive the child'); },
    async streamAppend(_runId: string, _stream: string, message: unknown) { appended.push(message); return {}; },
  } as unknown as JournalClient;
  return { journal, append, appended, resumes: () => resumes };
}

function terminalSnapshot(entries: Entry[]): RunGetResult {
  const run = entries.find(entry => entry['entry_type'] === 'run.completed');
  const reason = (run?.['payload'] as { completionReason?: string } | undefined)?.completionReason;
  return {
    run_id: 'child-1',
    status: reason === undefined ? 'running' : reason === 'success' ? 'completed' : 'failed',
    steps: { 'run-2': { type: 'deterministic', state: reason === undefined ? 'running' : 'done' } },
    budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
  };
}

describe('readCompletedStepOutput on a child run that retried an attempt', () => {
  it('resolves the terminal success, not the crashed attempt before it', async () => {
    // The journal Cloud's executor e2e produced after a kill mid-step and
    // `flows resume`: crash recovery's `crashed`/`retry`, then attempt 2.
    const { journal, appended } = childJournal([
      started(1), completed(1, 'crashed', 'retry'), backoff(1, 0), { entry_type: 'wait.completed', step_id: 'run-2' },
      started(2), completed(2, 'success', 'step_done', ok), runCompleted('success'),
    ], terminalSnapshot);
    const steps: AuthoredFlowJournalStep[] = [];

    await expect(readCompletedStepOutput(journal, 'child-1', 'run-2', steps, { rootRunId: 'root-1' }))
      .resolves.toEqual(ok);
    // Evidence names the terminal completion only.
    expect(steps).toEqual([{ id: 'run-2', runId: 'child-1', completionReason: 'success' }]);
    expect(appended).toEqual([expect.objectContaining({
      step: 'run-2', runId: 'child-1', state: 'completed', completionReason: 'success',
    })]);
  });

  it('reports the terminal failure reason, not the retried attempt\'s', async () => {
    const { journal, appended } = childJournal([
      started(1), completed(1, 'worker_error', 'retry'), backoff(1, 0),
      started(2), completed(2, 'retries_exhausted', 'step_done',
        { exit_code: 3, stdout_tail: '', stderr_tail: 'second failure' }),
      runCompleted('step_failed'),
    ], terminalSnapshot);
    const steps: AuthoredFlowJournalStep[] = [];

    const failure = await readCompletedStepOutput(journal, 'child-1', 'run-2', steps, { rootRunId: 'root-1' })
      .then(() => undefined, (error: Error & { completionReason?: string }) => error);

    expect(failure?.message).toContain('journal step "run-2" completed with retries_exhausted');
    expect(failure?.message).not.toContain('completed with worker_error');
    expect(failure?.completionReason).toBe('retries_exhausted');
    expect(steps).toEqual([{ id: 'run-2', runId: 'child-1', completionReason: 'retries_exhausted' }]);
    expect(appended).toEqual([expect.objectContaining({ completionReason: 'retries_exhausted' })]);
  });

  it('reports the run\'s reason when it settled between attempts', async () => {
    // Canceled during the backoff: no attempt settled the step, so the run's
    // own verdict is the failure — not the retried attempt, and not a
    // "malformed journal".
    const { journal, appended } = childJournal([
      started(1), completed(1, 'crashed', 'retry'), backoff(1, 0), runCompleted('canceled'),
    ], terminalSnapshot);
    const steps: AuthoredFlowJournalStep[] = [];

    const failure = await readCompletedStepOutput(journal, 'child-1', 'run-2', steps, { rootRunId: 'root-1' })
      .then(() => undefined, (error: Error & { code?: string }) => error);

    expect(failure?.code).toBe('step_failed');
    expect(failure?.message).toContain('journal run for step "run-2" completed with canceled');
    expect(failure?.message).not.toContain('crashed');
    expect(steps).toEqual([]);
    expect(appended).toEqual([expect.objectContaining({ completionReason: 'canceled' })]);
  });
});

describe('readCompletedStepOutput on an adopted child that is not terminal yet', () => {
  it('waits out the retry backoff and the next attempt, without driving the child', async () => {
    // `run.start` under an existing admission key returns the child as it
    // stands. Here it is mid-backoff after a crashed attempt, still being
    // driven by the request that started it.
    let polls = 0;
    const child = childJournal([started(1), completed(1, 'crashed', 'retry'), backoff(1, Date.now() + 200)],
      entries => {
        polls += 1;
        if (polls === 3) child.append(started(2));
        if (polls === 5) { child.append(completed(2, 'success', 'step_done', ok)); child.append(runCompleted('success')); }
        const snapshot = terminalSnapshot(entries);
        if (snapshot.status === 'running' && polls < 3) {
          return { ...snapshot, steps: { 'run-2': { type: 'deterministic', state: 'backoff' } } };
        }
        if (snapshot.status === 'running') {
          return { ...snapshot, steps: { 'run-2': { type: 'deterministic', state: 'running', lease_deadline_ms: Date.now() + 60_000 } } };
        }
        return snapshot;
      });
    const steps: AuthoredFlowJournalStep[] = [];

    await expect(readCompletedStepOutput(child.journal, 'child-1', 'run-2', steps)).resolves.toEqual(ok);
    expect(steps.map(step => step.completionReason)).toEqual(['success']);
    expect(child.resumes()).toBe(0);
    expect(polls).toBeGreaterThanOrEqual(5);
  });

  it('refuses rather than reads once the running attempt has outlived its lease', async () => {
    const child = childJournal([started(1)], () => ({
      run_id: 'child-1', status: 'running',
      steps: { 'run-2': { type: 'deterministic', state: 'running', lease_deadline_ms: Date.now() - 60_000 } },
      budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
    }));

    await expect(readCompletedStepOutput(child.journal, 'child-1', 'run-2', []))
      .rejects.toThrow(/step "run-2" passed its lease .* without reaching a terminal state/u);
  });

  it('stops waiting when the flow is canceled', async () => {
    const controller = new AbortController();
    const child = childJournal([started(1)], () => ({
      run_id: 'child-1', status: 'running',
      steps: { 'run-2': { type: 'deterministic', state: 'running', lease_deadline_ms: Date.now() + 60_000 } },
      budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
    }));
    setTimeout(() => controller.abort(), 100);

    await expect(readCompletedStepOutput(child.journal, 'child-1', 'run-2', [], { signal: controller.signal }))
      .rejects.toThrow(/cancel/u);
  });

  it('reports the attempt that ran to a result when the child is parked on a worker nobody attached', async () => {
    // A helper drives exactly one attempt: its provider failure is retried,
    // the retry dies with the helper's connection (a kernel-recorded
    // `crashed`), and the run parks for want of a worker. Nothing will settle
    // the step, and the provider failure is why.
    const child = childJournal([
      started(1), { ...completed(1, 'worker_error', 'retry'), payload: { completionReason: 'worker_error', disposition: 'retry', output: null, completed_by: 'helper' } },
      started(2), { ...completed(2, 'crashed', 'retry'), payload: { completionReason: 'crashed', disposition: 'retry', output: null, completed_by: 'kernel' } },
    ], () => ({
      run_id: 'child-1', status: 'running',
      steps: { 'run-2': { type: 'agent', state: 'runnable' } },
      budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
    }));
    const steps: AuthoredFlowJournalStep[] = [];

    const failure = await readCompletedStepOutput(child.journal, 'child-1', 'run-2', steps)
      .then(() => undefined, (error: Error & { completionReason?: string }) => error);

    expect(failure?.completionReason).toBe('worker_error');
    expect(steps.map(step => step.completionReason)).toEqual(['worker_error']);
    expect(child.resumes()).toBe(0);
  });
});

/** A named gate lowers to a dependent `<step>.gate` step in the child's own spec. */
const gateStarted: Entry = { entry_type: 'step.attempt.started', step_id: 'run-2.gate', attempt: 1, payload: { max_iterations: 1 } };
const gateCompleted = (completionReason: string): Entry => ({
  entry_type: 'step.completed', step_id: 'run-2.gate', attempt: 1,
  payload: { completionReason, disposition: 'step_done', output: null },
});
const snapshotOf = (status: RunGetResult['status'], gate: RunGetResult['steps'][string]): RunGetResult => ({
  run_id: 'child-1', status,
  steps: { 'run-2': { type: 'deterministic', state: 'done' }, 'run-2.gate': gate },
  budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
});

describe('readCompletedStepOutput on an adopted gated child whose gate has not started', () => {
  // The producer's success is journaled; its named gate is still `runnable`
  // (not started), so the child has neither `run.completed` nor an open
  // attempt. The gate's verdict, arriving later, is the operation's.
  function gatedChild(gateVerdict: 'success' | 'verification_failed') {
    let polls = 0;
    const child = childJournal([started(1), completed(1, 'success', 'step_done', ok)], () => {
      polls += 1;
      if (polls === 3) child.append(gateStarted);
      if (polls === 5) {
        child.append(gateCompleted(gateVerdict));
        child.append(runCompleted(gateVerdict === 'success' ? 'success' : 'step_failed'));
        return snapshotOf(gateVerdict === 'success' ? 'completed' : 'failed', { type: 'deterministic', state: 'done' });
      }
      return snapshotOf('running', polls < 3
        ? { type: 'deterministic', state: 'runnable' }
        : { type: 'deterministic', state: 'running', lease_deadline_ms: Date.now() + 60_000 });
    });
    return child;
  }

  it('fails the authored step when the gate later fails', async () => {
    const child = gatedChild('verification_failed');
    const failure = await readCompletedStepOutput(child.journal, 'child-1', 'run-2', [])
      .then(() => undefined, (error: Error & { code?: string }) => error);

    expect(failure?.code).toBe('step_failed');
    expect(failure?.message).toContain('journal run for step "run-2" completed with step_failed');
    expect(child.resumes()).toBe(0);
  });

  it('resolves the producer output when the gate later passes', async () => {
    const child = gatedChild('success');
    await expect(readCompletedStepOutput(child.journal, 'child-1', 'run-2', [])).resolves.toEqual(ok);
    expect(child.resumes()).toBe(0);
  });

  it('refuses a producer success when the wait ends with the run still not terminal', async () => {
    // Nothing ever starts the gate: after the settling window the run is
    // still `running`, so there is no verdict to read — not a success.
    const child = childJournal([started(1), completed(1, 'success', 'step_done', ok)],
      () => snapshotOf('running', { type: 'deterministic', state: 'runnable' }));
    const failure = await readCompletedStepOutput(child.journal, 'child-1', 'run-2', [])
      .then(() => undefined, (error: Error & { code?: string }) => error);

    expect(failure?.code).toBe('journal_protocol_violation');
    expect(failure?.message).toContain('is not terminal (status: running)');
    expect(child.resumes()).toBe(0);
  });
});

describe('waiting on a retry backoff whose wake passes mid-poll', () => {
  afterEach(() => { vi.restoreAllMocks(); });

  it('keeps polling through the elapsed wake and resolves when the next attempt completes', async () => {
    // Fake clock: the wake is still ahead when the backoff deadline is read,
    // and has passed by the time the waiter compares against it — the
    // kernel's driver is folding the timer, not failing.
    let now = 1_000_000;
    const wake = now + 10;
    // Armed by the journal read that finds the `sleep.until`: the NEXT clock
    // read (the backoff's own "has it woken?" check) still sees the wake
    // ahead; every read after it — the waiter's deadline check — sees it past.
    let readsBeforeWake: number | undefined;
    vi.spyOn(Date, 'now').mockImplementation(() => {
      if (readsBeforeWake !== undefined && readsBeforeWake-- === 0) { now = wake + 1; readsBeforeWake = undefined; }
      return now;
    });
    let polls = 0;
    let passWakeOnRead = false;
    const child = childJournal([started(1), completed(1, 'crashed', 'retry'), backoff(1, wake)], entries => {
      polls += 1;
      if (polls === 1) {
        passWakeOnRead = true;
        return { ...terminalSnapshot(entries), steps: { 'run-2': { type: 'deterministic', state: 'backoff' } } };
      }
      if (polls === 2) child.append(started(2));
      if (polls === 3) { child.append(completed(2, 'success', 'step_done', ok)); child.append(runCompleted('success')); }
      const snapshot = terminalSnapshot(entries);
      return snapshot.status === 'running'
        ? { ...snapshot, steps: { 'run-2': { type: 'deterministic', state: 'running', lease_deadline_ms: now + 60_000 } } }
        : snapshot;
    });
    const read = child.journal.journalRead.bind(child.journal);
    child.journal.journalRead = (async (...args: Parameters<typeof read>) => {
      const page = await read(...args);
      if (passWakeOnRead) { passWakeOnRead = false; readsBeforeWake = 1; }
      return page;
    }) as typeof read;

    await expect(readCompletedStepOutput(child.journal, 'child-1', 'run-2', [])).resolves.toEqual(ok);
    expect(polls).toBe(3);
    expect(child.resumes()).toBe(0);
  });
});

