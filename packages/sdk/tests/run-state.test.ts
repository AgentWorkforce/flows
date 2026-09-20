import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { JournalEvent } from '../src/journal-client.js';
import { foldRunState, RunStateError } from '../src/run-state.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
// A real completed kernel run: agent → deterministic → deterministic, all successful.
const COMPLETED = readFileSync(join(ROOT, 'docs/evidence/journal-close-0909/completed.journal.jsonl'), 'utf8')
  .trim().split('\n').map((line) => JSON.parse(line) as JournalEvent);
const RUN_ID = COMPLETED[0]!.run_id;
const T0 = 1_788_961_144_343;

/** Hand-build an in-flight journal from `run.spawned` on. */
function journal(...entries: Array<Partial<JournalEvent> & { entry_type: string }>): JournalEvent[] {
  return entries.map((entry, index) => ({
    seq: index + 1, segment_id: 1, run_id: RUN_ID, step_id: null, attempt: null, at_ms: T0 + index * 1000, payload: {},
    ...entry,
  }));
}

const SPEC = {
  name: 'hn-monitor/analyze',
  steps: [
    { id: 'fetch', type: 'deterministic', depends_on: [], max_iterations: 1, command: 'curl', instruction: 'SECRET-INSTRUCTION' },
    { id: 'analyze', type: 'agent', depends_on: ['fetch'], max_iterations: 3, instruction: 'Analyze the SECRET-INSTRUCTION' },
    { id: 'post', type: 'agent', depends_on: ['analyze'], max_iterations: 1 },
  ],
};
const spawned = { entry_type: 'run.spawned', payload: { spec: SPEC, spec_hash: 'h', parent_run_id: null, journal_version: 1, created_by: 't' } };
const started = (step: string, attempt: number, lease: number, at: number) => ({
  entry_type: 'step.attempt.started', step_id: step, attempt, at_ms: at,
  payload: { step_type: 'agent', idempotency_key: 'k', lease_id: 'l', lease_deadline_ms: lease, executor: 'worker', pins: {}, max_iterations: 3 },
});
const completed = (step: string, attempt: number, at: number, extra: Record<string, unknown>) => ({
  entry_type: 'step.completed', step_id: step, attempt, at_ms: at,
  payload: {
    completionReason: 'success', disposition: 'step_done', output: { exit_code: 0, stdout_tail: 'ok', stderr_tail: '' },
    verification: { gate: 'exit_code', verdict: 'pass', detail: 'all gates passed' }, end_pins: null, effects: [],
    budget: { tokens_in: 0, tokens_out: 0, dollars: '0' }, completed_by: 'w', next_attempt_at_ms: null, ...extra,
  },
});

describe('foldRunState', () => {
  it('folds the completed fixture into three done steps and a completed run', () => {
    const view = foldRunState(COMPLETED, COMPLETED.at(-1)!.at_ms + 5000);
    expect(view).toMatchObject({
      run_id: RUN_ID, name: 'journal-close-repro', status: 'completed', completion_reason: 'success',
      spawned_at_ms: COMPLETED[0]!.at_ms,
      spend: { tokens_in: 0, tokens_out: 0, dollars: '0', dollars_unmetered: false },
      counts: { total: 3, done: 3, running: 0, pending: 0, backoff: 0, waiting: 0, needs_human: 0 },
    });
    expect(view.steps.map((step) => [step.id, step.type, step.state, step.attempt])).toEqual([
      ['implement', 'agent', 'done', 1], ['verify', 'deterministic', 'done', 1], ['report', 'deterministic', 'done', 1],
    ]);
    const implement = view.steps[0]!;
    expect(implement.last_attempt).toEqual({
      attempt: 1, completion_reason: 'success', disposition: 'step_done',
      verification: { gate: 'output_contains', verdict: 'pass', detail: 'all gates passed' },
      human_intervention: false, effects: 0, ended_at_ms: COMPLETED[3]!.at_ms,
      // The fixture predates the transcript digest (#491).
      transcript: null,
    });
    expect(implement.elapsed_ms).toBe(COMPLETED[3]!.at_ms - COMPLETED[2]!.at_ms);
    expect(implement.lease).toBeNull();
    // The wrapper output carried no `artifacts` key, so none are journaled.
    expect(implement.artifacts).toEqual({ paths: [], journaled: false });
    // Nothing from the spec or the outputs is in the model.
    expect(JSON.stringify(view)).not.toMatch(/instruction|stdout_tail|Print DONE|VERIFIED|REPORTED/);
  });

  it('shows a running step with its lease, elapsed time and the failed attempt before it', () => {
    const now = T0 + 600_000;
    const events = journal(
      spawned,
      started('fetch', 1, T0 + 30_000, T0 + 1000),
      completed('fetch', 1, T0 + 3100, {}),
      started('analyze', 1, T0 + 40_000, T0 + 4000),
      completed('analyze', 1, T0 + 100_000, {
        completionReason: 'worker_error', disposition: 'retry', output: null,
        verification: { gate: 'execution', verdict: 'fail', detail: 'CLI invocation timed out after 600000ms. token=rk_live_abc' },
        next_attempt_at_ms: T0 + 130_000,
      }),
      started('analyze', 2, now + 23_000, T0 + 130_000),
    );
    const view = foldRunState(events, now);
    expect(view.status).toBe('running');
    expect(view.completion_reason).toBeNull();
    expect(view.counts).toEqual({ total: 3, done: 1, running: 1, pending: 1, backoff: 0, waiting: 0, needs_human: 0 });
    const analyze = view.steps[1]!;
    expect(analyze).toMatchObject({
      id: 'analyze', type: 'agent', state: 'running', attempt: 2, max_iterations: 3,
      started_at_ms: T0 + 130_000, elapsed_ms: now - (T0 + 130_000),
      lease: { deadline_ms: now + 23_000, overdue_ms: 0 }, backoff_until_ms: null, wait: null,
    });
    // The failed agent attempt's `output` is nulled by the kernel (machine.rs);
    // the gate verdict and its detail still explain why it ended.
    expect(analyze.last_attempt).toMatchObject({
      attempt: 1, completion_reason: 'worker_error', disposition: 'retry',
      verification: { gate: 'execution', verdict: 'fail', detail: expect.stringContaining('timed out') },
    });
    // The fold is raw; redaction is the renderer's job.
    expect(analyze.last_attempt!.verification!.detail).toContain('rk_live_abc');
    expect(view.steps[2]).toMatchObject({ id: 'post', state: 'pending', attempt: 0, started_at_ms: null, elapsed_ms: null });
  });

  it('reports an overdue lease from the journal and the clock alone', () => {
    const now = T0 + 100_000;
    const view = foldRunState(journal(spawned, started('fetch', 1, T0 + 59_000, T0 + 1000)), now);
    expect(view.steps[0]!.lease).toEqual({ deadline_ms: T0 + 59_000, overdue_ms: 41_000 });
  });

  it('shows backoff after a retry with the wake time, and pending steps stay pending', () => {
    const events = journal(
      spawned,
      started('fetch', 1, T0 + 30_000, T0 + 1000),
      completed('fetch', 1, T0 + 2000, { completionReason: 'verification_failed', disposition: 'retry', next_attempt_at_ms: T0 + 9000 }),
    );
    const view = foldRunState(events, T0 + 5000);
    expect(view.steps[0]).toMatchObject({ state: 'backoff', attempt: 1, backoff_until_ms: T0 + 9000, lease: null, elapsed_ms: 1000 });
    expect(view.counts.backoff).toBe(1);
    expect(view.steps[1]!.state).toBe('pending');
  });

  it('marks a dependency-satisfied step runnable and counts it as pending', () => {
    const view = foldRunState(journal(spawned, started('fetch', 1, T0 + 30_000, T0 + 1000), completed('fetch', 1, T0 + 2000, {})), T0 + 3000);
    expect(view.steps.map((step) => step.state)).toEqual(['done', 'runnable', 'pending']);
    expect(view.counts).toMatchObject({ done: 1, pending: 2 });
  });

  it('parks the run on wait.human and on a parked completion', () => {
    const human = foldRunState(journal(
      spawned, started('fetch', 1, T0 + 30_000, T0 + 1000),
      { entry_type: 'wait.human', step_id: 'fetch', attempt: 1, payload: { wait_id: 'human-1', prompt: 'Approve? SECRET-PROMPT', requested_of: 'x', timeout_at_ms: T0 + 90_000 } },
    ), T0 + 5000);
    expect(human.status).toBe('parked');
    expect(human.steps[0]).toMatchObject({ state: 'needs_human', wait: { wait_id: 'human-1', kind: 'human', timeout_at_ms: T0 + 90_000 } });
    expect(JSON.stringify(human)).not.toContain('SECRET-PROMPT');

    const parked = foldRunState(journal(
      spawned, started('fetch', 1, T0 + 30_000, T0 + 1000),
      completed('fetch', 1, T0 + 2000, { completionReason: 'verification_failed', disposition: 'park' }),
    ), T0 + 5000);
    expect(parked.status).toBe('parked');
    expect(parked.steps[0]).toMatchObject({ state: 'needs_human', wait: { wait_id: 'park-fetch-1', kind: 'human', timeout_at_ms: null } });
    expect(parked.counts.needs_human).toBe(1);
  });

  it('shows an event wait, then runnable once it completes, then done when cancelled', () => {
    const waiting = journal(
      spawned, started('fetch', 1, T0 + 30_000, T0 + 1000),
      { entry_type: 'wait.event', step_id: 'fetch', attempt: 1, payload: { wait_id: 'evt-1', event_key: 'k', timeout_at_ms: null } },
    );
    let view = foldRunState(waiting, T0 + 5000);
    expect(view.status).toBe('running');
    expect(view.steps[0]).toMatchObject({ state: 'waiting', wait: { wait_id: 'evt-1', kind: 'event', timeout_at_ms: null } });
    expect(view.counts.waiting).toBe(1);

    view = foldRunState([...waiting, ...journal({ entry_type: 'wait.completed', step_id: 'fetch', payload: { wait_id: 'evt-1', completionReason: 'event_received', result: {} } }).map((e) => ({ ...e, seq: 4 }))], T0 + 5000);
    expect(view.steps[0]!.state).toBe('runnable');

    view = foldRunState([...waiting, ...journal({ entry_type: 'wait.completed', step_id: 'fetch', payload: { wait_id: 'evt-1', completionReason: 'canceled', result: null } }).map((e) => ({ ...e, seq: 4 }))], T0 + 5000);
    expect(view.steps[0]).toMatchObject({ state: 'done', last_attempt: { completion_reason: 'canceled' } });
  });

  it('derives failed, cancelling and cancelled run states', () => {
    const failed = foldRunState(journal(
      spawned, started('fetch', 1, T0 + 30_000, T0 + 1000),
      completed('fetch', 1, T0 + 2000, { completionReason: 'retries_exhausted' }),
      { entry_type: 'run.completed', payload: { completionReason: 'step_failed', failed_step_id: 'fetch', budget_total: { tokens_in: 7, tokens_out: 3, dollars: '0.5' } } },
    ), T0 + 9000);
    expect(failed).toMatchObject({ status: 'failed', completion_reason: 'step_failed', spend: { tokens_in: 7, tokens_out: 3, dollars: '0.5' } });

    const cancelling = foldRunState(journal(spawned, { entry_type: 'run.cancel.requested', payload: { requested_by: 'op' } }), T0 + 9000);
    expect(cancelling.status).toBe('cancelling');

    const cancelled = foldRunState(journal(
      spawned, { entry_type: 'run.cancel.requested', payload: { requested_by: 'op' } },
      { entry_type: 'run.completed', payload: { completionReason: 'canceled', failed_step_id: null, budget_total: { tokens_in: 0, tokens_out: 0, dollars: '0' } } },
    ), T0 + 9000);
    expect(cancelled).toMatchObject({ status: 'cancelled', completion_reason: 'canceled' });
  });

  it('sums spend across completions in microdollars, sticky on unmetered, seeded from prior_spend', () => {
    const withPrior = { ...spawned, payload: { ...spawned.payload, spec: { ...SPEC, budget: { prior_spend: { tokens_in: 100, tokens_out: 10, dollars: '1.25', wallclock_ms: 0 } } } } };
    const view = foldRunState(journal(
      withPrior,
      started('fetch', 1, T0 + 30_000, T0 + 1000),
      completed('fetch', 1, T0 + 2000, { budget: { tokens_in: 1000, tokens_out: 200, dollars: '0.000123' } }),
      started('analyze', 1, T0 + 40_000, T0 + 3000),
      completed('analyze', 1, T0 + 4000, { completionReason: 'worker_error', disposition: 'retry', output: null, budget: { tokens_in: 5, tokens_out: 5, dollars: '0.1', dollars_unmetered: true } }),
    ), T0 + 5000);
    expect(view.spend).toEqual({ tokens_in: 1105, tokens_out: 215, dollars: '1.350123', dollars_unmetered: true });
  });

  it('records journaled artifact paths from the wrapper output, and nothing else from it', () => {
    const view = foldRunState(journal(
      spawned, started('analyze', 1, T0 + 30_000, T0 + 1000),
      completed('analyze', 1, T0 + 2000, { output: { exit_code: 0, stdout_tail: 'PRIVATE-OUTPUT', stderr_tail: '', artifacts: ['report.md', 'out/data.json'] }, end_pins: {} }),
    ), T0 + 5000);
    expect(view.steps[1]!.artifacts).toEqual({ paths: ['report.md', 'out/data.json'], journaled: true });
    expect(JSON.stringify(view)).not.toContain('PRIVATE-OUTPUT');
  });

  it('applies an epoch summary by restarting every step and restoring the carried ones', () => {
    const view = foldRunState(journal(
      spawned, started('fetch', 1, T0 + 30_000, T0 + 1000), completed('fetch', 1, T0 + 2000, {}),
      { entry_type: 'epoch.summary', payload: {
        epoch: 2, prev_segment_id: 1, journal_version: 1,
        steps_done: { fetch: { completionReason: 'success', output: {} } },
        steps_open: { analyze: { attempt: 2, state: 'backoff', wake_at_ms: T0 + 50_000 } },
        budget_spent: { tokens_in: 9, tokens_out: 1, dollars: '0.01' },
      } },
    ), T0 + 5000);
    expect(view.steps.map((step) => step.state)).toEqual(['done', 'backoff', 'pending']);
    expect(view.steps[1]).toMatchObject({ attempt: 2, backoff_until_ms: T0 + 50_000 });
    expect(view.spend).toMatchObject({ tokens_in: 9, tokens_out: 1, dollars: '0.01' });
  });

  // --- review findings on flows#492 -------------------------------------

  it('carries each done step\'s completion reason across an epoch summary', () => {
    // `steps_done[id].completionReason` was discarded, `last_attempt` stayed
    // null, and the dependency check required `last_attempt.completion_reason
    // === 'success'` — so `analyze` stayed pending after a compaction and
    // `fetch` rendered with the failure glyph.
    const view = foldRunState(journal(
      spawned, started('fetch', 1, T0 + 30_000, T0 + 1000), completed('fetch', 1, T0 + 2000, {}),
      { entry_type: 'epoch.summary', payload: {
        epoch: 2, prev_segment_id: 1, journal_version: 1,
        steps_done: { fetch: { completionReason: 'success', output: {} } },
        steps_open: {},
        budget_spent: { tokens_in: 0, tokens_out: 0, dollars: '0' },
      } },
    ), T0 + 5000);
    const [fetch, analyze, post] = view.steps;
    expect(fetch).toMatchObject({ state: 'done', completion_reason: 'success' });
    // The reason is carried; no attempt record is invented around it.
    expect(fetch!.last_attempt).toBeNull();
    expect(analyze!.state).toBe('runnable');
    // `post` depends on `analyze`, which has not succeeded.
    expect(post!.state).toBe('pending');
  });

  it('does not make a dependent runnable behind a failed carried step', () => {
    const view = foldRunState(journal(
      spawned,
      { entry_type: 'epoch.summary', payload: {
        epoch: 2, prev_segment_id: 1, journal_version: 1,
        steps_done: { fetch: { completionReason: 'failed', output: {} } },
        steps_open: {}, budget_spent: { tokens_in: 0, tokens_out: 0, dollars: '0' },
      } },
    ), T0 + 5000);
    expect(view.steps[0]).toMatchObject({ state: 'done', completion_reason: 'failed' });
    expect(view.steps[1]!.state).toBe('pending');
  });

  it('leaves a carried running step\'s start time unknown rather than stamping the epoch', () => {
    // Stamping `event.at_ms` made the live attempt tail header look stale to
    // readTranscriptTail and restarted elapsed at the compaction.
    const view = foldRunState(journal(
      spawned,
      { entry_type: 'epoch.summary', payload: {
        epoch: 2, prev_segment_id: 1, journal_version: 1, steps_done: {},
        steps_open: { fetch: { attempt: 3, state: 'running', lease_deadline_ms: T0 + 60_000 } },
        budget_spent: { tokens_in: 0, tokens_out: 0, dollars: '0' },
      } },
    ), T0 + 5000);
    expect(view.steps[0]).toMatchObject({
      state: 'running', attempt: 3, started_at_ms: null, elapsed_ms: null,
      lease: { deadline_ms: T0 + 60_000, overdue_ms: 0 },
    });
  });

  it('sets completion_reason on an ordinary completion too', () => {
    const view = foldRunState(journal(
      spawned, started('fetch', 1, T0 + 30_000, T0 + 1000),
      completed('fetch', 1, T0 + 2000, { completionReason: 'failed' }),
    ), T0 + 5000);
    expect(view.steps[0]).toMatchObject({ state: 'done', completion_reason: 'failed' });
    expect(view.steps[1]!.state).toBe('pending');
  });

  it('measures a live wait from the current attempt, not a previous one\'s end', () => {
    // `ended_at_ms` belongs to the attempt that ended; after a retry it is
    // older than the new attempt's start, and elapsed clamped to zero.
    const view = foldRunState(journal(
      spawned,
      started('fetch', 1, T0 + 30_000, T0 + 1000),
      completed('fetch', 1, T0 + 2000, { disposition: 'retry', completionReason: 'failed', next_attempt_at_ms: T0 + 3000 }),
      started('fetch', 2, T0 + 40_000, T0 + 10_000),
      { entry_type: 'sleep.until', step_id: 'fetch', attempt: 2, at_ms: T0 + 11_000, payload: { wake_at_ms: T0 + 90_000 } },
    ), T0 + 20_000);
    const fetch = view.steps[0]!;
    expect(fetch.state).toBe('backoff');
    expect(fetch.started_at_ms).toBe(T0 + 10_000);
    expect(fetch.elapsed_ms).toBe(10_000);
  });

  it('adds decimal dollars at full precision, beyond six fractional digits', () => {
    // Microdollar scaling returned null past six digits and the nullish
    // fallback contributed zero, so `flows status` underreported spend.
    const charge = (at: number, dollars: string) => ({
      entry_type: 'step.completed', step_id: 'fetch', attempt: 1, at_ms: at,
      payload: {
        completionReason: 'success', disposition: 'step_done', output: {}, verification: null,
        end_pins: null, effects: [], budget: { tokens_in: 0, tokens_out: 0, dollars },
        completed_by: 'w', next_attempt_at_ms: null,
      },
    });
    const view = foldRunState(journal(
      spawned, started('fetch', 1, T0 + 30_000, T0 + 1000), charge(T0 + 2000, '0.0000001'),
    ), T0 + 5000);
    expect(view.spend.dollars).toBe('0.0000001');

    const many = foldRunState(journal(
      spawned,
      started('fetch', 1, T0 + 30_000, T0 + 1000), charge(T0 + 2000, '0.0000001'),
      started('analyze', 1, T0 + 30_000, T0 + 3000), charge(T0 + 4000, '1.23'),
    ), T0 + 6000);
    // Aligned at the wider scale, exactly, the way the kernel's fold adds them.
    expect(many.spend.dollars).toBe('1.2300001');
  });

  // --- composition with the transcript digest (#491 x #492) --------------

  it('surfaces the transcript digest the worker journals in trajectory_tail', () => {
    const view = foldRunState(journal(
      spawned, started('analyze', 1, T0 + 30_000, T0 + 1000),
      completed('analyze', 1, T0 + 2000, {
        trajectory_tail: {
          transcript: {
            attempt: 1, exit_code: 0,
            file: { path: '.relayflowd/runs/r/steps/analyze/attempt-1.transcript.jsonl',
              bytes_total: 4000, bytes_kept: 4000, frames_total: 14, frames_kept: 14,
              truncated: false, sha256: 'a'.repeat(64) },
            result: { provider: 'claude', model: 'claude-opus-4', num_turns: 6, total_cost_usd: 0.42 },
            tools: { counts: [{ name: 'Bash', calls: 3, errors: 0 }], last_calls: [], total_calls: 3, shown_calls: 0, complete: true },
          },
        },
      }),
    ), T0 + 5000);
    expect(view.steps[1]!.last_attempt!.transcript).toEqual({
      path: '.relayflowd/runs/r/steps/analyze/attempt-1.transcript.jsonl',
      bytes: 4000, truncated: false, model: 'claude-opus-4',
      num_turns: 6, total_cost_usd: 0.42, tool_calls: 3, failure: null,
    });
  });

  it('carries the digest\'s failure excerpt', () => {
    const view = foldRunState(journal(
      spawned, started('analyze', 1, T0 + 30_000, T0 + 1000),
      completed('analyze', 1, T0 + 2000, {
        completionReason: 'worker_error',
        trajectory_tail: { transcript: { failure: { kind: 'stderr', excerpt: 'ECONNREFUSED', truncated: true } } },
      }),
    ), T0 + 5000);
    expect(view.steps[1]!.last_attempt!.transcript).toMatchObject({
      failure: { kind: 'stderr', excerpt: 'ECONNREFUSED' }, path: null, model: null,
    });
  });

  it('is null when the attempt journaled no digest, and never throws on a malformed one', () => {
    const none = foldRunState(journal(
      spawned, started('analyze', 1, T0 + 30_000, T0 + 1000), completed('analyze', 1, T0 + 2000, {}),
    ), T0 + 5000);
    expect(none.steps[1]!.last_attempt!.transcript).toBeNull();
    // A worker older or newer than this reader: every field is taken defensively.
    const junk = foldRunState(journal(
      spawned, started('analyze', 1, T0 + 30_000, T0 + 1000),
      completed('analyze', 1, T0 + 2000, {
        trajectory_tail: { transcript: { file: 'not-an-object', result: 7, tools: null, failure: [] } },
      }),
    ), T0 + 5000);
    expect(junk.steps[1]!.last_attempt!.transcript).toEqual({
      path: null, bytes: null, truncated: false, model: null,
      num_turns: null, total_cost_usd: null, tool_calls: null, failure: null,
    });
  });

  it('refuses a journal that does not begin with run.spawned or names an unknown step', () => {
    expect(() => foldRunState([], 0)).toThrow(RunStateError);
    expect(() => foldRunState(journal(spawned, started('ghost', 1, 1, 1)), 0)).toThrow(/unknown step "ghost"/);
  });
});
