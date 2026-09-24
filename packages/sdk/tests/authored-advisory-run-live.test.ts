// `f.run(..., { onNonZero: 'record' })` against the live kernel.
//
// The claim under test is the one `<command> || true` cannot make: a red
// command does not end the flow, AND the branch below it reads the command's
// real exit code and real output, back from the journal. Every assertion here
// is therefore about the values an author actually receives — not about the
// spec that was compiled to produce them.

import { flow } from '@relayflows/surface';
import { afterEach, describe, expect, it } from 'vitest';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import type { AuthoredFlowExecutionError } from '../src/authored-flow-error.js';
import { readRecordedOutcome } from '../src/authored-step-output.js';
import type { JournalClient } from '../src/journal-client.js';
import type { RunOutcome } from '../src/protocol.js';
import { chainFixture } from './flow-chain-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

describe('a recorded nonzero f.run through the live kernel', () => {
  it('resolves to the journaled exit code instead of ending the flow', async () => {
    const fixture = chainFixture();
    cleanup.push(() => fixture.close());
    const journal = await fixture.connect();

    let seen: unknown;
    let reachedRepair = false;
    const handle = flow('repair-before-failure', async (f) => {
      const check = await f.run(
        'printf \'2 failing tests\'; printf \'stack trace\' >&2; exit 7',
        { onNonZero: 'record' });
      seen = check;
      if (!check.ok) {
        // The repair-before-failure shape from the ticket: the red command's
        // own output is the input to whatever answers it.
        const echoed = await f.run(`printf '%s' ${JSON.stringify(check.stdout)}`);
        reachedRepair = echoed === '2 failing tests';
      }
      f.done('success');
    });

    const result = await executeAuthoredFlow(handle, journal, undefined, { dataDir: fixture.data });

    expect(result.completionReason).toBe('success');
    expect(seen).toEqual({
      ok: false, exitCode: 7,
      stdout: '2 failing tests', stderr: 'stack trace',
      output: '2 failing tests\nstack trace',
    });
    expect(reachedRepair).toBe(true);
    // The step is a SUCCESSFUL step whose exit code happens to be 7. Recording
    // does not invent a completion reason, and it does not retry.
    expect(result.journalSteps.find(step => step.id === 'run-1'))
      .toMatchObject({ completionReason: 'success' });
  }, 30_000);

  it('resolves a green command through the same policy', async () => {
    const fixture = chainFixture();
    cleanup.push(() => fixture.close());
    const journal = await fixture.connect();

    let seen: unknown;
    const handle = flow('recorded-green', async (f) => {
      seen = await f.run('printf all-green', { onNonZero: 'record' });
      f.done('success');
    });

    await executeAuthoredFlow(handle, journal, undefined, { dataDir: fixture.data });

    expect(seen).toEqual({ ok: true, exitCode: 0, stdout: 'all-green', stderr: '', output: 'all-green' });
  }, 30_000);

  // The default is what every existing body is written against, and the whole
  // feature is opt-in. A policy-free call must be untouched by this change.
  it('leaves the default fatal and still resolving to the stdout string', async () => {
    const fixture = chainFixture();
    cleanup.push(() => fixture.close());
    const journal = await fixture.connect();

    const handle = flow('default-still-fatal', async (f) => {
      expect(await f.run('printf plain')).toBe('plain');
      await f.run('exit 4');
      f.done('success');
    });

    await expect(executeAuthoredFlow(handle, journal, undefined, { dataDir: fixture.data }))
      .rejects.toThrow(/step "run-2"/u);
  }, 30_000);

  // Recording is a policy about EXIT CODES. A command killed by its lease
  // produced no exit status to record, so there is nothing to hand an author's
  // `if (!result.ok)` and the step still fails.
  it('still fails a timeout, which recorded no exit code to report', async () => {
    const fixture = chainFixture();
    cleanup.push(() => fixture.close());
    const journal = await fixture.connect();

    const handle = flow('recorded-timeout', async (f) => {
      await f.run('sleep 30', { onNonZero: 'record', timeout: '150ms' });
      f.done('success');
    });

    const failure = await executeAuthoredFlow(handle, journal, undefined, { dataDir: fixture.data })
      .then(() => undefined, (error) => error as { code?: string; details?: Record<string, unknown> });

    expect(failure?.code).toBe('lease_exceeded');
    expect(failure?.details?.['stepId']).toBe('run-1');
  }, 30_000);

  // A declared gate is the author's own assertion, not the exit-code policy's,
  // so recording must not soften it. The producer here completes successfully —
  // that is the point. A named gate lowers to its own kernel step that runs
  // AFTER the producer, so the producer's `success` entry is not the run's
  // verdict, and reading only that entry used to resolve the operation as
  // though the gate had passed.
  it.each([
    ['a recorded step', { onNonZero: 'record' } as const],
    ['a default step', undefined],
  ])('still fails a declared named gate on %s whose producer succeeded', async (_label, options) => {
    const fixture = chainFixture();
    cleanup.push(() => fixture.close());
    const journal = await fixture.connect();

    const handle = flow('named-gate-failure', async (f) => {
      // `printf` exits 0 under either policy: the only thing that can fail
      // this operation is the gate.
      await f.run('printf nothing-useful', options)
        .gate({ type: 'regex_match', pattern: 'ready', in_output_at: ['stdout_tail'] });
      f.done('success');
    });

    const failure = await executeAuthoredFlow(handle, journal, undefined, { dataDir: fixture.data })
      .then(() => undefined, (error) => error as AuthoredFlowExecutionError);

    expect(failure?.code).toBe('step_failed');
    // The RUN's reason, and the generated gate step named as the culprit —
    // not the producer, which really did succeed.
    expect(failure?.completionReason).toBe('step_failed');
    expect(failure?.details?.stepId).toBe('run-1.gate');
    // And the child run itself is terminally failed, so nothing downstream can
    // read this operation as a pass.
    expect((await journal.runGet(failure!.runId!)).status).toBe('failed');
  }, 30_000);

  // A predicate gate judges the value the author received, so on a recording
  // step it judges the `RunResult` — including the exit code the policy kept.
  it('hands a predicate gate the recorded result, not the stdout string', async () => {
    const fixture = chainFixture();
    cleanup.push(() => fixture.close());
    const journal = await fixture.connect();

    let judged: unknown;
    const handle = flow('recorded-predicate', async (f) => {
      await f.run('printf out; exit 5', { onNonZero: 'record' })
        .gate((result) => { judged = result; return result.exitCode === 5; });
      f.done('success');
    });

    await executeAuthoredFlow(handle, journal, undefined, { dataDir: fixture.data });

    expect(judged).toMatchObject({ ok: false, exitCode: 5, stdout: 'out' });
  }, 30_000);

  it('refuses a policy value the kernel enum does not name, before journaling anything', async () => {
    const fixture = chainFixture();
    cleanup.push(() => fixture.close());
    const journal = await fixture.connect();

    const handle = flow('bad-policy', async (f) => {
      // A JavaScript caller, or a cast, can reach this. Falling back to the
      // fatal default would delete the branch the author wrote below it.
      await f.run('true', { onNonZero: 'ignore' } as never);
      f.done('success');
    });

    await expect(executeAuthoredFlow(handle, journal, undefined, { dataDir: fixture.data }))
      .rejects.toThrow(/onNonZero must be 'fail' or 'record'/u);
  }, 30_000);
});

describe('reading a recorded outcome from a malformed envelope', () => {
  /** A journal whose single completion carries whatever output is given. */
  function completedWith(output: unknown): JournalClient {
    return {
      async journalRead() {
        return { entries: [{
          seq: 1, entry_type: 'step.completed', step_id: 'run-1',
          payload: { completionReason: 'success', disposition: 'step_done', output },
        }] };
      },
    } as unknown as JournalClient;
  }

  const read = (output: unknown) => readRecordedOutcome(
    completedWith(output), { run_id: 'child-1' } as RunOutcome, 'run-1', []);

  it('accepts a well-formed envelope', async () => {
    await expect(read({ exit_code: 2, stdout_tail: 'out', stderr_tail: 'err' }))
      .resolves.toEqual({ ok: false, exitCode: 2, stdout: 'out', stderr: 'err', output: 'out\nerr' });
  });

  // `-1` is the executor's "no exit status" sentinel (exec_det.rs), not a
  // command's exit code. Handing it back as `ok: false` would present a
  // killed process as an ordinary red verdict.
  it.each([
    [{ exit_code: -1, stdout_tail: '', stderr_tail: '' }, 'the no-exit-status sentinel'],
    [{ exit_code: 1.5, stdout_tail: '', stderr_tail: '' }, 'a non-integer code'],
    [{ exit_code: 0, stderr_tail: '' }, 'a missing stdout tail'],
    [{ exit_code: 0, stdout_tail: '' }, 'a missing stderr tail'],
    [{ stdout_tail: '', stderr_tail: '' }, 'no code at all'],
    ['0', 'a non-object envelope'],
    [null, 'a null envelope'],
  ])('refuses %#: %s', async (output) => {
    await expect(read(output)).rejects.toThrow(/recorded no \{exit_code, stdout_tail, stderr_tail\}/u);
  });
});
