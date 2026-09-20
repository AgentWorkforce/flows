import { describe, expect, it, vi } from 'vitest';
import { stepFailedFrame } from '../src/authored-node-runner.js';
import { classifyOutcome, emptyReport, type RunDiagnostic } from '../src/cli/run.js';
import type { JournalClient } from '../src/journal-client.js';
import type { RunOutcome } from '../src/protocol.js';

// The field report this pins: a commit-and-push step was refused by a GitLab
// pre-receive hook, the retry re-ran a commit that had already landed and died
// for a different reason, and `retries_exhausted` reported only the second.
const REJECTION = "remote: GitLab: You cannot push commits for 'factory@example.com'";
const NOTHING_STAGED = 'nothing staged inside the declared scope';

const failure: RunOutcome = {
  run_id: 'run-failed', status: 'failed', completion_reason: 'step_failed', completed_steps: 0,
};

const DETERMINISTIC = { 'commit-and-push': { type: 'deterministic', state: 'done' } };
const AGENT = { 'commit-and-push': { type: 'agent', state: 'done' } };
const TWO_STEPS = { ...DETERMINISTIC, other: { type: 'deterministic', state: 'done' } };

interface Completion {
  seq: number;
  attempt?: number;
  stepId?: string;
  reason?: string;
  disposition?: string;
  output?: unknown;
  verification?: unknown;
  trajectory?: unknown;
}

/** One `step.completed` entry in the shape `completion_actions` appends. */
function completed(entry: Completion) {
  return {
    seq: entry.seq, entry_type: 'step.completed', step_id: entry.stepId ?? 'commit-and-push',
    ...(entry.attempt === undefined ? {} : { attempt: entry.attempt }),
    payload: {
      completionReason: entry.reason ?? 'verification_failed',
      disposition: entry.disposition ?? 'step_done',
      output: entry.output ?? null,
      ...(entry.verification === undefined ? {} : { verification: entry.verification }),
      ...(entry.trajectory === undefined ? {} : { trajectory_tail: entry.trajectory }),
    },
  };
}

/** `preserve_failure_output`'s shape for a failed deterministic attempt. */
function captured(exitCode: number, stderr: string, stdout = '') {
  return { exit_code: exitCode, stdout_tail: stdout, stderr_tail: stderr };
}

/** The daemon's bounded render, which is all an agent attempt leaves behind. */
function render(stderr: string, stdout = '') {
  return {
    gate: 'execution', verdict: 'fail',
    detail: JSON.stringify({ exit_code: 1, stdout_tail: stdout, stderr_tail: stderr }),
  };
}

function stub(pages: unknown[][], steps: Record<string, unknown> = DETERMINISTIC) {
  const runGet = vi.fn(async () => ({ steps }));
  const journalRead = vi.fn(async () => ({ entries: pages.shift() ?? [] }));
  return { client: { runGet, journalRead } as unknown as JournalClient, journalRead };
}

async function diagnose(pages: unknown[][], steps?: Record<string, unknown>) {
  const { client, journalRead } = stub(pages, steps);
  const execution = await classifyOutcome(
    client, 'run', failure, emptyReport('run'), '/tmp/attempts.sock', {});
  return {
    diagnostic: execution.report.diagnostics.at(-1) as RunDiagnostic,
    journalRead,
  };
}

/** A retried step, failing differently each time — the reported scenario. */
function divergentRetry() {
  return [
    completed({ seq: 1, attempt: 1, disposition: 'retry', output: captured(1, REJECTION) }),
    completed({
      seq: 2, attempt: 2, reason: 'retries_exhausted', output: captured(1, NOTHING_STAGED),
    }),
  ];
}

describe('attempt history in a retried step failure', () => {
  it("reports the first attempt's error beside the last and says they differ", async () => {
    const { diagnostic } = await diagnose([divergentRetry()]);
    expect(diagnostic.attempts).toEqual([
      {
        attempt: 1, completionReason: 'verification_failed', disposition: 'retry',
        exitCode: 1, stderrTail: REJECTION,
      },
      {
        attempt: 2, completionReason: 'retries_exhausted', disposition: 'step_done',
        exitCode: 1, stderrTail: NOTHING_STAGED,
      },
    ]);
    expect(diagnostic.attemptEvidence).toBe('differs');
    // The scalars still describe the terminal attempt; the history is additive.
    expect(diagnostic).toMatchObject({
      completionReason: 'retries_exhausted', exitCode: 1, stderrTail: NOTHING_STAGED,
    });
    const message = diagnostic.message;
    expect(message).toContain('Attempts: 2 failed; recorded failure evidence differs.');
    expect(message).toContain('An earlier attempt may have had side effects.');
    // Oldest first: the rejection that actually caused the failure is readable
    // without scrolling past the consequence of retrying it.
    expect(message.indexOf(REJECTION)).toBeLessThan(message.indexOf(NOTHING_STAGED));
    expect(message).toContain(`  attempt 1: verification_failed exit=1 — stderr: ${REJECTION}`);
  });

  it('does not call the exhaustion label a different failure', async () => {
    // `completion_actions` picks `verification_failed` on the retry branch and
    // `retries_exhausted` at the budget limit for the SAME cause. Comparing
    // the labels literally would announce side effects on every ordinary
    // repeated failure, which is the noise that makes a real one unreadable.
    const same = captured(1, REJECTION);
    const { diagnostic } = await diagnose([[
      completed({ seq: 1, attempt: 1, disposition: 'retry', output: same }),
      completed({ seq: 2, attempt: 2, reason: 'retries_exhausted', output: same }),
    ]]);
    expect(diagnostic.attemptEvidence).toBe('unchanged');
    expect(diagnostic.message).toContain('recorded failure evidence is unchanged across them');
    expect(diagnostic.message).not.toContain('side effects');
  });

  it('compares the unbounded record, not the excerpt two attempts share', async () => {
    const shared = 'x'.repeat(400);
    const { diagnostic } = await diagnose([[
      completed({
        seq: 1, attempt: 1, disposition: 'retry', output: captured(1, `${REJECTION}\n${shared}`),
      }),
      completed({
        seq: 2, attempt: 2, reason: 'retries_exhausted',
        output: captured(1, `${NOTHING_STAGED}\n${shared}`),
      }),
    ]]);
    // Both 256-byte excerpts are the same bytes. The difference survives only
    // because the comparison ran on the journal record, before the bound.
    expect(diagnostic.attempts![0]!.stderrTail).toBe(diagnostic.attempts![1]!.stderrTail);
    expect(diagnostic.attemptEvidence).toBe('differs');
    expect(diagnostic.attempts!.every(attempt => attempt.truncated)).toBe(true);
    expect(diagnostic.message).toContain('(excerpt truncated)');
  });

  it('sees a changed gate verdict behind identical process output', async () => {
    const output = captured(1, 'build failed');
    const gate = (detail: string) => ({ gate: 'exit_code+output_contains', verdict: 'fail', detail });
    const { diagnostic } = await diagnose([[
      completed({
        seq: 1, attempt: 1, disposition: 'retry', output,
        verification: gate('exit_code: expected 0, got 1'),
      }),
      completed({
        seq: 2, attempt: 2, reason: 'retries_exhausted', output,
        verification: gate('output_contains: missing "done"'),
      }),
    ]]);
    // The render is suppressed for display because the output is process
    // shaped — it is still read for the comparison.
    expect(diagnostic.attempts![0]).not.toHaveProperty('detail');
    expect(diagnostic.attemptEvidence).toBe('differs');
  });

  it('keeps stdout when stderr is empty rather than reporting nothing', async () => {
    const { diagnostic } = await diagnose([[
      completed({
        seq: 1, attempt: 1, disposition: 'retry',
        output: captured(1, '', 'pre-receive hook declined'),
      }),
      completed({
        seq: 2, attempt: 2, reason: 'retries_exhausted', output: captured(1, '', 'nothing to commit'),
      }),
    ]]);
    expect(diagnostic.message).toContain('stdout: pre-receive hook declined');
    expect(diagnostic.message).toContain('stdout: nothing to commit');
  });

  it('labels both accounts when an attempt left a detail and a tail', async () => {
    const { diagnostic } = await diagnose([[
      completed({
        seq: 1, attempt: 1, reason: 'worker_error', disposition: 'retry',
        verification: render('process stderr'),
        trajectory: { transcript: { failure: { kind: 'result', excerpt: 'Claude: budget exhausted' } } },
      }),
      completed({ seq: 2, attempt: 2, reason: 'worker_error', verification: render('rate limited') }),
    ]], AGENT);
    expect(diagnostic.attempts![0]).toMatchObject({
      detail: 'Claude: budget exhausted', stderrTail: 'process stderr',
    });
    expect(diagnostic.message).toContain('    detail: Claude: budget exhausted');
    expect(diagnostic.message).toContain('    stderr: process stderr');
  });

  it('reads each agent attempt out of the render the kernel kept', async () => {
    // The kernel nulls `output` on a failed non-deterministic completion, so
    // every attempt of a retried agent step survives only as this render.
    const { diagnostic } = await diagnose([[
      completed({
        seq: 1, attempt: 1, reason: 'worker_error', disposition: 'retry',
        verification: render('no such model'),
      }),
      completed({ seq: 2, attempt: 2, reason: 'worker_error', verification: render('rate limited') }),
    ]], AGENT);
    expect(diagnostic.attempts).toMatchObject([
      { attempt: 1, exitCode: 1, stderrTail: 'no such model' },
      { attempt: 2, exitCode: 1, stderrTail: 'rate limited' },
    ]);
    expect(diagnostic.attemptEvidence).toBe('differs');
  });

  it('will not call two renders the daemon already cut identical', async () => {
    // `worker_failure_detail` caps at 2,000 chars. Two attempts whose renders
    // agree up to the cut may have disagreed past it, and claiming they were
    // the same failure would be a claim the journal does not support.
    const detail = `analyzer exited 1: ${'y'.repeat(50)}… (2,048 bytes truncated)`;
    const { diagnostic } = await diagnose([[
      completed({
        seq: 1, attempt: 1, reason: 'worker_error', disposition: 'retry',
        verification: { gate: 'execution', verdict: 'fail', detail },
      }),
      completed({
        seq: 2, attempt: 2, reason: 'worker_error',
        verification: { gate: 'execution', verdict: 'fail', detail },
      }),
    ]], AGENT);
    expect(diagnostic.attemptEvidence).toBe('unknown');
    expect(diagnostic.message).toContain('whether the causes differ is unknown');
  });

  it('names the attempts it cannot account for instead of inventing evidence', async () => {
    const { diagnostic } = await diagnose([[
      completed({ seq: 1, reason: 'crashed', disposition: 'retry' }),
      completed({ seq: 2, reason: 'crashed' }),
    ]]);
    expect(diagnostic.attempts).toEqual([
      { completionReason: 'crashed', disposition: 'retry' },
      { completionReason: 'crashed', disposition: 'step_done' },
    ]);
    // Two attempts that recorded nothing cannot agree; they can only fail to
    // disagree, and `unchanged` would be an assertion about what was lost.
    expect(diagnostic.attemptEvidence).toBe('unknown');
    expect(diagnostic.message).toContain('attempt ?: crashed — no failure evidence recorded');
  });

  it('records a parked attempt as a failure of that attempt', async () => {
    const { diagnostic } = await diagnose([[
      completed({ seq: 1, attempt: 1, disposition: 'park', output: captured(1, REJECTION) }),
      completed({
        seq: 2, attempt: 2, reason: 'retries_exhausted', output: captured(1, NOTHING_STAGED),
      }),
    ]]);
    expect(diagnostic.attempts).toMatchObject([
      { attempt: 1, disposition: 'park', stderrTail: REJECTION },
      { attempt: 2, disposition: 'step_done', stderrTail: NOTHING_STAGED },
    ]);
  });

  it('renders every failed attempt rather than eliding the middle', async () => {
    // `flows logs` prints the runner log without eliding it, so an attempt
    // dropped here is an attempt that reaches no reader at all.
    const entries = Array.from({ length: 7 }, (_unused, index) => completed({
      seq: index + 1, attempt: index + 1,
      reason: index === 6 ? 'retries_exhausted' : 'verification_failed',
      disposition: index === 6 ? 'step_done' : 'retry',
      output: captured(1, `failure ${index + 1}`),
    }));
    const { diagnostic } = await diagnose([entries]);
    expect(diagnostic.attempts).toHaveLength(7);
    expect(diagnostic.message).toContain('Attempts: 7 failed');
    for (let attempt = 1; attempt <= 7; attempt += 1) {
      expect(diagnostic.message).toContain(`attempt ${attempt}: `);
      expect(diagnostic.message).toContain(`failure ${attempt}`);
    }
  });

  it("keeps one step's history across a page boundary and apart from another's", async () => {
    const { diagnostic, journalRead } = await diagnose([
      [
        completed({ seq: 1, attempt: 1, disposition: 'retry', output: captured(1, REJECTION) }),
        completed({
          seq: 2, attempt: 1, stepId: 'other', disposition: 'retry', output: captured(1, 'unrelated'),
        }),
      ],
      [
        completed({
          seq: 3, attempt: 2, stepId: 'other', reason: 'retries_exhausted',
          output: captured(1, 'unrelated'),
        }),
        completed({
          seq: 4, attempt: 2, reason: 'retries_exhausted', output: captured(1, NOTHING_STAGED),
        }),
      ],
    ], TWO_STEPS);
    expect(diagnostic.stepId).toBe('commit-and-push');
    expect(diagnostic.attempts).toMatchObject([
      { attempt: 1, stderrTail: REJECTION }, { attempt: 2, stderrTail: NOTHING_STAGED },
    ]);
    expect(journalRead.mock.calls).toEqual([
      ['run-failed', 1, 100], ['run-failed', 3, 100], ['run-failed', 5, 100],
    ]);
  });

  it('drops the attempts of a step that eventually succeeded', async () => {
    const { diagnostic } = await diagnose([[
      completed({ seq: 1, attempt: 1, disposition: 'retry', output: captured(1, REJECTION) }),
      completed({ seq: 2, attempt: 2, reason: 'success', output: captured(0, '') }),
      completed({
        seq: 3, attempt: 1, stepId: 'other', reason: 'retries_exhausted',
        output: captured(1, 'a later, different failure'),
      }),
    ]], TWO_STEPS);
    expect(diagnostic.stepId).toBe('other');
    expect(diagnostic).not.toHaveProperty('attempts');
    expect(diagnostic.message).not.toContain(REJECTION);
  });

  it('redacts a credential an attempt echoed before bounding the excerpt', async () => {
    const { diagnostic } = await diagnose([[
      completed({
        seq: 1, attempt: 1, disposition: 'retry',
        output: captured(1, 'push failed for rk_live_0123456789abcdef0123456789abcdef'),
      }),
      completed({
        seq: 2, attempt: 2, reason: 'retries_exhausted', output: captured(1, NOTHING_STAGED),
      }),
    ]]);
    expect(diagnostic.attempts![0]!.stderrTail).toBe('push failed for [redacted]');
    expect(diagnostic.message).not.toContain('rk_live_');
  });

  it('adds nothing at all to a single failed attempt', async () => {
    const { diagnostic } = await diagnose([[
      completed({ seq: 1, attempt: 1, reason: 'retries_exhausted', output: captured(7, 'only error') }),
    ]]);
    expect(diagnostic).not.toHaveProperty('attempts');
    expect(diagnostic).not.toHaveProperty('attemptEvidence');
    expect(diagnostic.message).not.toContain('Attempts:');
    expect(diagnostic.message).toContain('Stderr (last 1,024 bytes):\nonly error');
  });
});

describe('attempt history over the authored runtime IPC frame', () => {
  it('carries the history a child run read from its own journal', () => {
    const details = {
      stepId: 'commit-and-push', completionReason: 'retries_exhausted', attemptEvidence: 'differs',
      attempts: [
        {
          attempt: 1, completionReason: 'verification_failed', disposition: 'retry',
          exitCode: 1, stderrTail: REJECTION, truncated: true,
        },
        { attempt: 2, completionReason: 'retries_exhausted', disposition: 'step_done', detail: NOTHING_STAGED },
      ],
    };
    expect(stepFailedFrame(details)).toEqual(details);
  });

  it('drops malformed attempts without voiding the ones it can read', () => {
    expect(stepFailedFrame({
      attempts: ['nope', null, [], { attempt: 2.5, stderrTail: 'real', truncated: 'yes' }],
      attemptEvidence: 'maybe',
    })).toEqual({ attempts: [{ stderrTail: 'real' }] });
  });

  it('ignores an attempts field that is not a list', () => {
    expect(stepFailedFrame({ stepId: 'x', attempts: { attempt: 1 } })).toEqual({ stepId: 'x' });
  });
});
