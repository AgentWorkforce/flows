import { afterEach, describe, expect, it, vi } from 'vitest';
import { compileSpec, toKernelSpec } from '../src/compile.js';
import type { JournalClient } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';
import { SPEC_SCHEMA_VERSION } from '../src/spec.js';
import { withWorkerLease } from '../src/worker-lease.js';
import { renderStepEvidence, stepFailureDetails } from '../src/cli/step-failure.js';
import { chainFixture } from './flow-chain-fixture.js';

const closes: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of closes.splice(0).reverse()) await close();
});

/**
 * Customer rw_3a0fcb71 issue 1: an `f.agent` attempt lost its lease while the
 * worker was healthy and heartbeating, the kernel journaled `lease_expired`
 * and retried it. The daemon issues lease deadlines on ITS wall clock and the
 * worker judged them against ITS OWN `Date.now()`, so any skew between the two
 * clocks (a container VM that fell behind after sleep, an NTP step) moved the
 * worker's idea of the deadline:
 *
 * - worker clock AHEAD of the daemon by more than the 30s renewal: every
 *   dispatch is refused locally as `already_expired`, and nothing renews;
 * - worker clock BEHIND by more than ~60s: `remaining / 3` exceeds the lease,
 *   so the first renewal lands after the daemon has already swept it.
 *
 * These drive a real relayflowd and the real `withWorkerLease`; only the
 * worker's wall clock is skewed.
 */
describe('worker lease under clock skew between worker and daemon', () => {
  async function leasedAgentRun(): Promise<{
    journal: JournalClient;
    worker: JournalClient;
    runId: string;
    dispatch: StepDispatchEvent;
  }> {
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    const journal = await fixture.connect();
    const stream = 'drift-stream';
    const worker = journal.createPeer();
    await worker.connect();
    await worker.hello('drift-worker');
    closes.push(() => worker.close());
    const dispatched = new Promise<StepDispatchEvent>(resolve => worker.once('step.dispatch', resolve));
    await worker.workerAttach('drift-worker', ['agent'],
      { workspace: [], streams: [{ stream, read_offset: 0 }] }, 1);
    const spec = toKernelSpec(compileSpec({
      version: SPEC_SCHEMA_VERSION, name: 'drift',
      steps: [{ id: 'agent-1', type: 'agent', instruction: 'do it', maxIterations: 1, recoveryMode: 'reset',
        surfaces: { streams: [{ stream }] } }],
    }));
    const outcome = await journal.runStart(spec);
    return { journal, worker, runId: outcome.run_id, dispatch: await dispatched };
  }

  function skewWorkerClock(offsetMs: number): void {
    const real = Date.now.bind(Date);
    vi.spyOn(Date, 'now').mockImplementation(() => real() + offsetMs);
  }

  async function completions(journal: JournalClient, runId: string): Promise<Array<[unknown, unknown]>> {
    const entries = (await journal.journalRead(runId, 1, 1000)).entries as Array<{
      entry_type: string; payload?: { completionReason?: string; disposition?: string };
    }>;
    return entries.filter(entry => entry.entry_type === 'step.completed')
      .map(entry => [entry.payload?.completionReason, entry.payload?.disposition]);
  }

  it('holds the lease when the worker clock runs 45s ahead of the daemon', async () => {
    const { journal, worker, runId, dispatch } = await leasedAgentRun();
    skewWorkerClock(45_000);
    const output = await withWorkerLease(worker, dispatch, async () => 'done');
    expect(output).toBe('done');
    await worker.stepComplete(runId, dispatch.step_id, dispatch.attempt, dispatch.idempotency_key, 'success', {
      output: { stdout_tail: 'ok' }, started_pins: dispatch.pins, end_pins: dispatch.pins,
    });
    expect(await completions(journal, runId)).toEqual([['success', 'step_done']]);
  }, 30_000);

  it('renews before the daemon deadline when the worker clock runs 75s behind the daemon', async () => {
    const { journal, worker, runId, dispatch } = await leasedAgentRun();
    skewWorkerClock(-75_000);
    // Longer than one 30s lease: survives only if a renewal lands in time.
    const output = await withWorkerLease(worker, dispatch,
      () => new Promise<string>(resolve => setTimeout(() => resolve('done'), 36_000)));
    expect(output).toBe('done');
    await worker.stepComplete(runId, dispatch.step_id, dispatch.attempt, dispatch.idempotency_key, 'success', {
      output: { stdout_tail: 'ok' }, started_pins: dispatch.pins, end_pins: dispatch.pins,
    });
    expect(await completions(journal, runId)).toEqual([['success', 'step_done']]);
  }, 60_000);
});

describe('attempt accounting after a lost worker', () => {
  it('does not report attempt=2/1 when the first attempt died uncharged', async () => {
    // max_iterations 1; the first worker disconnects mid-attempt (kernel:
    // `crashed`, retry, no iteration charged) and the second attempt fails on
    // its own merits. Attempt 2 of a 1-iteration budget is correct kernel
    // behaviour, and the report has to say why rather than print `2/1`.
    const fixture = chainFixture();
    closes.push(() => fixture.close());
    const journal = await fixture.connect();
    const stream = 'accounting-stream';
    const attach = async (onDispatch: (worker: JournalClient, event: StepDispatchEvent) => void) => {
      const worker = journal.createPeer();
      await worker.connect();
      await worker.hello('accounting-worker');
      worker.on('step.dispatch', (event: StepDispatchEvent) => onDispatch(worker, event));
      await worker.workerAttach(`worker-${Math.random()}`, ['agent'],
        { workspace: [], streams: [{ stream, read_offset: 0 }] }, 1);
      return worker;
    };
    let firstDispatched!: () => void;
    const dispatchedToFirst = new Promise<void>(resolve => { firstDispatched = resolve; });
    const first = await attach(() => firstDispatched());
    const outcome = await journal.runStart(toKernelSpec(compileSpec({
      version: SPEC_SCHEMA_VERSION, name: 'accounting',
      steps: [{ id: 'agent-1', type: 'agent', instruction: 'do it', maxIterations: 1, recoveryMode: 'reset',
        surfaces: { streams: [{ stream }] } }],
    })));
    await dispatchedToFirst;
    const second = await attach((worker, event) => {
      void worker.stepComplete(event.run_id, event.step_id, event.attempt, event.idempotency_key, 'worker_error', {
        output: { exit_code: 1, stdout_tail: '', stderr_tail: 'boom' }, started_pins: event.pins, end_pins: event.pins,
      });
    });
    closes.push(() => second.close());
    first.close();
    const deadline = Date.now() + 30_000;
    while ((await journal.runResume(outcome.run_id, true)).status !== 'failed') {
      if (Date.now() > deadline) throw new Error('run did not fail');
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    const details = (await stepFailureDetails(journal, outcome.run_id))!;
    expect(details).toMatchObject({ stepId: 'agent-1', attempt: 2, maxIterations: 1, unchargedAttempts: 1 });
    const rendered = renderStepEvidence(details);
    expect(rendered).not.toContain('attempt=2/1');
    expect(rendered).toContain('attempt=2 (iteration 1/1; 1 earlier attempt lost to a dead worker, not charged)');
  }, 60_000);
});
