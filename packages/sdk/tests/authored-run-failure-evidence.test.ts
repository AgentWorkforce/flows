import { flow } from '@relayflows/surface';
import { afterEach, describe, expect, it } from 'vitest';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { readAuthoredStepIndex } from '../src/authored-step-index.js';
import { readCompletedStepOutput, readSuccessfulOutput } from '../src/authored-step-output.js';
import type { RunOutcome } from '../src/protocol.js';
import type { JournalClient } from '../src/journal-client.js';
import { chainFixture } from './flow-chain-fixture.js';
import { EXCERPT_BYTES } from '../src/cli/step-excerpt.js';

/** The one line the report has to name, and the one the old render always cut. */
const MARKER = 'not ok 111 - pty-exit: child process exit is detected';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

/**
 * A root run the child index can be appended to. `stream.append` requires a
 * mutable run (`server.rs` `ensure_mutable`), so the root here is an agent
 * step nobody attaches to: it stays waiting for the whole test, exactly as a
 * real authored root does while its body runs.
 */
async function openRoot(journal: JournalClient): Promise<string> {
  const outcome = await journal.runStart({
    version: '0.1.0',
    name: 'evidence-root',
    steps: [{
      id: 'authored-root', type: 'agent', instruction: '{}',
      surfaces: { streams: [{ stream: 'evidence-root-stream' }] },
      recovery_mode: 'reset', max_iterations: 1,
      retry: { max_transport_retries: 7 },
    }],
  } as never);
  return outcome.run_id;
}

describe('a failing f.run through the live kernel', () => {
  it('reports the command that failed and what it printed', async () => {
    const fixture = chainFixture();
    cleanup.push(() => fixture.close());
    const journal = await fixture.connect();

    const handle = flow('reads-its-own-failure', async (f) => {
      await f.run('printf \'boom on stderr\' >&2; exit 7');
      f.done('success');
    });

    const failure = await executeAuthoredFlow(handle, journal, undefined, { dataDir: fixture.data })
      .then(() => undefined, (error: Error) => error);

    expect(failure).toBeDefined();
    const message = failure!.message;
    // The four causes that used to be indistinguishable are separated by
    // these three facts: which step, what it exited with, and what it said.
    expect(message).toContain('step "run-1"');
    expect(message).toContain('exit=7');
    expect(message).toContain('boom on stderr');
    // `retries_exhausted` stays the kernel's word (AGENTS.md rule 7), but it
    // can no longer be read as "retries happened": the budget is printed
    // beside it, and a deterministic step's budget is one attempt.
    expect(message).toContain('retries_exhausted');
    expect(message).toMatch(/attempt=1\/1\b/u);
    // And the operator is told, in the message, how to read the rest.
    expect(message).toContain('Inspect: flows replay');
  });

  it('names the failing case from the middle of a real test run', async () => {
    // The reported bug, end to end: kernel capture -> journal ->
    // `preserve_failure_output` -> SDK render. A runner that streams results
    // and prints its totals last puts `ok` lines and a summary in the final
    // kilobyte by construction, so the one `not ok` was exactly the part the
    // old last-1,024-bytes render cut.
    const passing = (index: number) => `ok ${index} - pty: a passing case with a realistically long name`;
    const expected = [
      ...Array.from({ length: 110 }, (_, index) => passing(index + 1)),
      MARKER,
      ...Array.from({ length: 110 }, (_, index) => passing(index + 112)),
      '1..221', '# tests 221', '# pass 220', '# fail 1',
    ].join('\n') + '\n';
    const stream = Buffer.from(expected, 'utf8');
    const at = Buffer.byteLength(expected.slice(0, expected.indexOf(MARKER)), 'utf8');
    // The fixture is only evidence if the failure sits where the old render
    // could not reach and where head-and-tail context alone would not either:
    // past the first 4 KiB, before the last 4 KiB, and inside the 64 KiB the
    // kernel captures (`OUTPUT_TAIL_BYTES`, relayflowd/src/exec_det.rs).
    expect(at).toBeGreaterThan(4_096);
    expect(stream.length - at).toBeGreaterThan(4_096);
    expect(stream.length).toBeGreaterThan(12 * 1_024);
    expect(stream.length).toBeLessThan(20 * 1_024);
    expect(stream.subarray(-1_024).toString('utf8')).not.toContain(MARKER);

    const fixture = chainFixture();
    cleanup.push(() => fixture.close());
    const journal = await fixture.connect();

    const handle = flow('streamed-test-run', async (f) => {
      await f.run(`i=1; while [ $i -le 110 ]; do printf 'ok %s - pty: a passing case with a realistically long name\\n' "$i"; i=$((i+1)); done
printf '${MARKER}\\n'
i=112; while [ $i -le 221 ]; do printf 'ok %s - pty: a passing case with a realistically long name\\n' "$i"; i=$((i+1)); done
printf '1..221\\n# tests 221\\n# pass 220\\n# fail 1\\n'
exit 1`);
      f.done('success');
    });

    const failure = await executeAuthoredFlow(handle, journal, undefined, { dataDir: fixture.data })
      .then(() => undefined, (error) => error as { message: string; details?: Record<string, unknown> });

    // The journal is the record: check the failing line is in the completion
    // the kernel wrote before asking what the renderer did with it.
    const childRunId = /flows replay (\S+)/u.exec(String(failure?.details?.['hint']))?.[1];
    expect(childRunId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);
    const entries = (await journal.journalRead(childRunId!, 1)).entries as Array<{
      entry_type: string; payload?: { output?: { stdout_tail?: string } };
    }>;
    const journaled = entries.find(entry => entry.entry_type === 'step.completed')?.payload?.output?.stdout_tail;
    expect(journaled).toBe(expected);

    // And the render names it, inside its own byte bound, with the head and
    // the summary still beside it.
    const excerpt = String(failure?.details?.['stdoutTail']);
    expect(excerpt).toContain(MARKER);
    expect(excerpt).toContain('ok 1 - pty: a passing case with a realistically long name');
    expect(excerpt).toContain('# fail 1');
    expect(Buffer.byteLength(excerpt, 'utf8')).toBeLessThanOrEqual(EXCERPT_BYTES);
    expect(failure?.message).toContain('Stdout (captured excerpt):');
    expect(failure?.message).toContain(MARKER);
  }, 30_000);

  it('carries the same facts structurally, not only rendered into the message', async () => {
    const fixture = chainFixture();
    cleanup.push(() => fixture.close());
    const journal = await fixture.connect();

    const handle = flow('structured', async (f) => {
      await f.run('printf \'structured stderr\' >&2; exit 3');
      f.done('success');
    });

    const failure = await executeAuthoredFlow(handle, journal, undefined, { dataDir: fixture.data })
      .then(() => undefined, (error) => error as { details?: Record<string, unknown> });

    expect(failure?.details).toMatchObject({
      stepId: 'run-1',
      stepType: 'deterministic',
      completionReason: 'retries_exhausted',
      attempt: 1,
      maxIterations: 1,
      exitCode: 3,
    });
    expect(String(failure?.details?.['stderrTail'])).toContain('structured stderr');
  });

  it('keeps the evidence when the failure is relabelled as a timeout', async () => {
    const fixture = chainFixture();
    cleanup.push(() => fixture.close());
    const journal = await fixture.connect();

    const handle = flow('timed-out', async (f) => {
      await f.run('sleep 30', { timeout: '150ms' });
      f.done('success');
    });

    const failure = await executeAuthoredFlow(handle, journal, undefined, { dataDir: fixture.data })
      .then(() => undefined, (error) => error as { code?: string; details?: Record<string, unknown> });

    // `readSuccessfulOutput` rewrites this into `lease_exceeded`. A timeout is
    // still a failed command; relabelling it must not delete what it left.
    expect(failure?.code).toBe('lease_exceeded');
    expect(failure?.details?.['stepId']).toBe('run-1');
    expect(failure?.details?.['completionReason']).toMatch(/timeout|lease_expired/u);
  }, 30_000);
});

describe('when the evidence itself cannot be read', () => {
  /** A journal that answers the completion read and fails every inspection. */
  function unreadable(reason: string): JournalClient {
    return {
      async journalRead() {
        return { entries: [{
          seq: 1, entry_type: 'step.completed', step_id: 'run-1',
          payload: { completionReason: reason, disposition: 'step_done', output: null },
        }] };
      },
      async runGet() { throw new Error('journal unavailable'); },
    } as unknown as JournalClient;
  }

  it('keeps the step failure and explains the inspection failure beside it', async () => {
    // Rule: one failure must not hide the other. The step failure is what the
    // operator came for; the read failure tells them why there is no more.
    const failure = await readCompletedStepOutput(unreadable('retries_exhausted'), 'child-1', 'run-1', [])
      .then(() => undefined, (error: Error) => error);

    expect(failure?.message).toContain('step "run-1" completed with retries_exhausted');
    expect(failure?.message).toContain('Could not inspect the failed step: journal unavailable');
    // The footer is built from the run id alone, so it survives exactly the
    // case where nothing else could be read.
    expect(failure?.message).toContain('Inspect: flows replay child-1');
  });

  it('still records the step in journalSteps, because the completion was read', async () => {
    const journalSteps: Array<{ id: string; completionReason: string }> = [];
    await readCompletedStepOutput(unreadable('crashed'), 'child-1', 'run-1', journalSteps as never)
      .catch(() => undefined);

    expect(journalSteps).toEqual([{ id: 'run-1', runId: 'child-1', completionReason: 'crashed' }]);
  });

  it.each(['timeout', 'lease_expired'])('preserves inspection and persistence failures on %s', async (reason) => {
    const journal = unreadable(reason);
    journal.streamAppend = async () => { throw new Error('index unavailable'); };
    const failure = await readSuccessfulOutput(journal, { run_id: 'child-1' } as RunOutcome,
      'run-1', [], { rootRunId: 'root-1' })
      .then(() => undefined, (error) => error);

    expect(failure.code).toBe('lease_exceeded');
    expect(failure.message).toContain('f.run step "run-1" exceeded its command timeout');
    expect(failure.message).toContain(`completed with ${reason}`);
    expect(failure.message).toContain('Could not inspect the failed step: journal unavailable');
    expect(failure.message).toContain('Could not persist the step index: index unavailable');
    expect(failure.message).toContain('Inspect: flows replay child-1');
    expect(failure.message).not.toContain('undefined');
    expect(failure.details.hint).toContain('flows replay child-1');
  });
});

describe('the child index after the process that wrote it is gone', () => {
  it('still names every child, with its own run id, after a daemon restart', async () => {
    const fixture = chainFixture();
    cleanup.push(() => fixture.close());
    let journal = await fixture.connect();
    const rootRunId = await openRoot(journal);

    // Enough successful operations to push the index past the 2,000-character
    // cap a `verification.detail` render is held to, and past the point where
    // a single `stream.read` page could hold the whole answer's provenance.
    const handle = flow('many-then-one-failure', async (f) => {
      for (let i = 0; i < 20; i++) await f.run(`printf ok-${i}`);
      await f.run('printf \'the failing command\' >&2; exit 9');
      f.done('success');
    });

    await expect(executeAuthoredFlow(handle, journal, undefined, {
      rootRunId, dataDir: fixture.data,
    })).rejects.toThrow(/step "run-21"/u);

    // Drop the client and the daemon: nothing that held the index in memory
    // survives. This is the sandbox going away.
    journal = await fixture.restart();

    const index = await readAuthoredStepIndex(journal, rootRunId);
    const byStep = new Map(index.map(record => [record.step, record]));

    expect(index).toHaveLength(21);
    for (let i = 1; i <= 20; i++) {
      expect(byStep.get(`run-${i}`)).toMatchObject({ state: 'completed', completionReason: 'success' });
    }
    // The failing operation is the one the diagnosis needs, and it names the
    // child run whose journal holds the command, its exit code and its output.
    const failed = byStep.get('run-21');
    expect(failed).toMatchObject({ state: 'completed', completionReason: 'retries_exhausted' });
    expect(failed?.runId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/u);

    // Every claimed child is a real run the restarted daemon can still open,
    // and the failing one still holds the command's own output.
    const entries = (await journal.journalRead(failed!.runId, 1)).entries as Array<{
      entry_type: string; payload?: { output?: { exit_code?: number; stderr_tail?: string } };
    }>;
    const completed = entries.find(entry => entry.entry_type === 'step.completed');
    expect(completed?.payload?.output?.exit_code).toBe(9);
    expect(completed?.payload?.output?.stderr_tail).toContain('the failing command');

    expect(JSON.stringify(index).length).toBeGreaterThan(2000);
  }, 60_000);
});
