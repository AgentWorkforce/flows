// A committed verdict survives the environment it was redacted in.
//
// The terminal marker's command embeds the detail, and the marker run is
// opened under a stable admission key. Normalization redacts against
// `process.env`, so a credential rotated or removed while the process was down
// makes the SAME authored sentence normalize differently — and a body resumed
// into that environment would retry the marker's admission key with a drifted
// spec. The kernel refuses that as `run_admission_conflict`, and a flow whose
// every step succeeded loses the explanation its root had already journaled.
//
// These run against the real daemon and inject the loss at the executor seam:
// the marker's admission is committed in the kernel and the response never
// reaches this process. That is not a claim of a process-kill end-to-end test;
// it is the exact window the completed-root resume test cannot cover, because
// that one starts with the root output already durable.

import { afterEach, expect, it } from 'vitest';
import { flow } from '@relayflows/surface';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { readAuthoredVerdict } from '../src/authored-completion-record.js';
import type { JournalClient } from '../src/journal-client.js';
import { chainFixture } from './flow-chain-fixture.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

/** The synthetic credential; the name is what `redact.ts` treats as secret. */
const SECRET_NAME = 'RELAYFLOWS_RECOVERY_TEST_SECRET';
const FIRST = 'opaque-recovery-value-123';
const ROTATED = 'rotated-recovery-value-456';
const RAW = `review found credential ${FIRST} in the agent's output`;
const REDACTED = `review found credential [redacted:${SECRET_NAME}] in the agent's output`;

/**
 * A root that stays mutable: an agent step pinned to a stream no worker holds
 * parks, so the body's own children and stream appends are admitted against a
 * live run — the same shape `authored-run-failure-evidence.test.ts` opens.
 */
async function openRoot(journal: JournalClient): Promise<string> {
  const outcome = await journal.runStart({
    version: '0.1.0',
    name: 'recovery-root',
    steps: [{
      id: 'authored-root', type: 'agent', instruction: '{}',
      surfaces: { streams: [{ stream: 'recovery-root-stream' }] },
      recovery_mode: 'reset', max_iterations: 8,
    }],
  } as never);
  return outcome.run_id;
}

/**
 * Run the body once, losing the response to its FIRST `run.start` — the
 * terminal marker's, for a body with no other steps. The kernel keeps the
 * admission; this process is told nothing. Returns the run id it never saw.
 */
async function loseTheMarkerResponse(
  journal: JournalClient, run: () => Promise<unknown>,
): Promise<string> {
  const start = journal.runStart.bind(journal);
  let admitted: string | undefined;
  const client = journal as { runStart: JournalClient['runStart'] };
  client.runStart = async (...args) => {
    const outcome = await start(...args);
    if (admitted === undefined) {
      admitted = outcome.run_id;
      throw new Error('injected loss after the marker was admitted');
    }
    return outcome;
  };
  try {
    await expect(run()).rejects.toThrow('injected loss after the marker was admitted');
  } finally {
    client.runStart = start;
  }
  if (admitted === undefined) throw new Error('the marker was never admitted');
  return admitted;
}

it('reuses the committed detail after the redaction environment rotates', async () => {
  const fixture = chainFixture();
  cleanup.push(() => fixture.close());
  const journal = await fixture.connect();
  const rootRunId = await openRoot(journal);
  const handle = flow('redaction-recovery', async (f) => {
    f.done('step_failed', { detail: RAW });
  });
  const run = () => executeAuthoredFlow(handle, journal, undefined,
    { rootRunId, dataDir: fixture.data });
  const prior = process.env[SECRET_NAME];

  try {
    process.env[SECRET_NAME] = FIRST;
    const admitted = await loseTheMarkerResponse(journal, run);

    // The credential is rotated while this process is "down". The author's
    // sentence is unchanged; only what redaction makes of it has moved, and
    // recomputing the marker from it is what the kernel refuses as
    // `run_admission_conflict`.
    process.env[SECRET_NAME] = ROTATED;
    const result = await run();

    // The verdict reached the root before the marker did, so it was readable
    // even though nothing had learned what the marker's run id was.
    expect(await readAuthoredVerdict(journal, rootRunId, 'complete-1'))
      .toEqual({ reason: 'step_failed', detail: REDACTED });
    expect(result.completionReason).toBe('step_failed');
    expect(result.completionDetail).toBe(REDACTED);
    expect(result.completionDetail).not.toContain(FIRST);
    // The SAME marker run, not a second one: the recovered detail rebuilt the
    // identical spec, so the stable admission key returned its existing run.
    expect(result.journalSteps.map((step) => step.id)).toEqual(['complete-1']);
    expect(result.journalSteps.at(-1)!.runId).toBe(admitted);
  } finally {
    if (prior === undefined) delete process.env[SECRET_NAME];
    else process.env[SECRET_NAME] = prior;
  }
}, 60_000);

it('commits the verdict once, and a clean re-execution reads it back', async () => {
  const fixture = chainFixture();
  cleanup.push(() => fixture.close());
  const journal = await fixture.connect();
  const rootRunId = await openRoot(journal);
  const handle = flow('committed-once', async (f) => {
    f.done('declined', { detail: 'the ticket names no repository' });
  });
  const run = () => executeAuthoredFlow(handle, journal, undefined,
    { rootRunId, dataDir: fixture.data });

  const first = await run();
  const second = await run();

  expect(second.completionDetail).toBe(first.completionDetail);
  expect(second.journalSteps.at(-1)!.runId).toBe(first.journalSteps.at(-1)!.runId);
  // One record on the stream, from the first execution; the second recovered
  // it rather than appending its own.
  const page = await journal.streamRead(rootRunId, 'authored-verdict', 0, 1000);
  expect(page.messages).toHaveLength(1);
}, 60_000);

/** The env var that stands in for an optional detail source a retry can lose. */
const OPTIONAL_DETAIL = 'RELAYFLOWS_RECOVERY_OPTIONAL_DETAIL';
const OPTIONAL_TEXT = 'review found 1 P2: cleanup remains ambiguous';

/** A body whose detail exists only while `OPTIONAL_DETAIL` is set. */
function optionalDetailFlow() {
  return flow('optional-detail', async (f) => {
    f.done('step_failed', { detail: process.env[OPTIONAL_DETAIL] });
  });
}

it('recovers a committed verdict when a no-detail retry follows a pre-marker loss', async () => {
  const fixture = chainFixture();
  cleanup.push(() => fixture.close());
  const journal = await fixture.connect();
  const rootRunId = await openRoot(journal);
  const run = () => executeAuthoredFlow(optionalDetailFlow(), journal, undefined,
    { rootRunId, dataDir: fixture.data });
  const prior = process.env[OPTIONAL_DETAIL];

  try {
    process.env[OPTIONAL_DETAIL] = OPTIONAL_TEXT;
    // Die BEFORE the marker is admitted: runStart never reaches the kernel.
    const start = journal.runStart.bind(journal);
    const client = journal as { runStart: JournalClient['runStart'] };
    client.runStart = async () => { throw new Error('injected loss before the marker was admitted'); };
    try {
      await expect(run()).rejects.toThrow('injected loss before the marker was admitted');
    } finally {
      client.runStart = start;
    }

    // The verdict still reached the root stream first.
    expect(await readAuthoredVerdict(journal, rootRunId, 'complete-1'))
      .toEqual({ reason: 'step_failed', detail: OPTIONAL_TEXT });

    // The retry's optional source is gone, so this attempt has no detail at
    // all. The committed record must still be authoritative: "no detail this
    // attempt" is not "no detail was ever recorded".
    delete process.env[OPTIONAL_DETAIL];
    const result = await run();
    expect(result.completionReason).toBe('step_failed');
    expect(result.completionDetail).toBe(OPTIONAL_TEXT);
    // And no second verdict record was appended for the no-detail attempt.
    const page = await journal.streamRead(rootRunId, 'authored-verdict', 0, 1000);
    expect(page.messages).toHaveLength(1);
  } finally {
    if (prior === undefined) delete process.env[OPTIONAL_DETAIL];
    else process.env[OPTIONAL_DETAIL] = prior;
  }
}, 60_000);

it('reuses the admitted marker when a no-detail retry follows a post-marker loss', async () => {
  const fixture = chainFixture();
  cleanup.push(() => fixture.close());
  const journal = await fixture.connect();
  const rootRunId = await openRoot(journal);
  const run = () => executeAuthoredFlow(optionalDetailFlow(), journal, undefined,
    { rootRunId, dataDir: fixture.data });
  const prior = process.env[OPTIONAL_DETAIL];

  try {
    process.env[OPTIONAL_DETAIL] = OPTIONAL_TEXT;
    const admitted = await loseTheMarkerResponse(journal, run);

    // Retry without the optional source: rebuilding the marker with no detail
    // would drift the spec under the same admission key and the kernel would
    // refuse it as `run_admission_conflict`. Recovering the committed record
    // rebuilds the identical spec instead.
    delete process.env[OPTIONAL_DETAIL];
    const result = await run();
    expect(result.completionReason).toBe('step_failed');
    expect(result.completionDetail).toBe(OPTIONAL_TEXT);
    expect(result.journalSteps.at(-1)!.runId).toBe(admitted);
  } finally {
    if (prior === undefined) delete process.env[OPTIONAL_DETAIL];
    else process.env[OPTIONAL_DETAIL] = prior;
  }
}, 60_000);

it('leaves a one-argument done() writing nothing to the verdict stream', async () => {
  const fixture = chainFixture();
  cleanup.push(() => fixture.close());
  const journal = await fixture.connect();
  const rootRunId = await openRoot(journal);
  const handle = flow('no-detail', async (f) => { f.done('step_failed'); });

  const result = await executeAuthoredFlow(handle, journal, undefined,
    { rootRunId, dataDir: fixture.data });

  expect(result.completionReason).toBe('step_failed');
  expect('completionDetail' in result).toBe(false);
  // Nothing to drift and nothing to recover: the marker command is a function
  // of the reason alone, so this flow's journal is the one it always wrote.
  const page = await journal.streamRead(rootRunId, 'authored-verdict', 0, 1000);
  expect(page.messages).toEqual([]);
}, 60_000);
