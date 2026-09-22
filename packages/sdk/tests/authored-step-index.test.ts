import { describe, expect, it } from 'vitest';
import type { JournalClient } from '../src/journal-client.js';
import {
  AUTHORED_STEP_STREAM,
  alsoRecord,
  readAuthoredStepIndex,
  recordAuthoredChild,
} from '../src/authored-step-index.js';

/**
 * A stand-in for the daemon's stream storage with the kernel's own paging
 * contract (`engine/remote.rs` `read_stream`): offsets are dense per stream,
 * a read returns at most `limit` messages from `from_offset`, and
 * `next_offset` is one past the last message it returned.
 */
function streams() {
  const stored = new Map<string, unknown[]>();
  const key = (runId: string, stream: string): string => `${runId}\u0000${stream}`;
  const journal = {
    async streamAppend(runId: string, stream: string, message: unknown) {
      const list = stored.get(key(runId, stream)) ?? [];
      stored.set(key(runId, stream), list);
      list.push(message);
      return { offset: list.length - 1 };
    },
    async streamRead(runId: string, stream: string, fromOffset: number, limit: number) {
      const list = stored.get(key(runId, stream)) ?? [];
      const messages = list.slice(fromOffset, fromOffset + limit);
      return { messages, next_offset: fromOffset + messages.length };
    },
  };
  return { journal: journal as unknown as JournalClient, stored, key };
}

describe('the durable child index on the root run', () => {
  it('records an admitted child before it can be known to have completed', async () => {
    const { journal, stored, key } = streams();

    await recordAuthoredChild(journal, 'root-1', {
      step: 'run-1', runId: 'child-a', state: 'admitted',
    });

    // The pointer must already name the child, because the answer to "which
    // run holds the evidence" has to survive the step it is waiting on.
    expect(stored.get(key('root-1', AUTHORED_STEP_STREAM))).toEqual([{
      index: 'relayflows.authored-step.v1',
      step: 'run-1', runId: 'child-a', state: 'admitted',
    }]);
  });

  it('lets a completion supersede the admission for the same step', async () => {
    const { journal } = streams();
    await recordAuthoredChild(journal, 'root-1', { step: 'run-1', runId: 'child-a', state: 'admitted' });
    await recordAuthoredChild(journal, 'run-2-root', { step: 'other', runId: 'x', state: 'admitted' });
    await recordAuthoredChild(journal, 'root-1', {
      step: 'run-1', runId: 'child-a', state: 'completed', completionReason: 'retries_exhausted',
    });

    expect(await readAuthoredStepIndex(journal, 'root-1')).toEqual([{
      index: 'relayflows.authored-step.v1',
      step: 'run-1', runId: 'child-a', state: 'completed', completionReason: 'retries_exhausted',
    }]);
  });

  it('never lets a later admission erase a recorded completion', async () => {
    // A resumed root re-runs its body to the same call. Re-admission is
    // idempotent at the kernel (`authoredChildAdmissionKey`), but the index
    // read must not downgrade a step the journal already saw terminate.
    const { journal } = streams();
    await recordAuthoredChild(journal, 'root-1', {
      step: 'run-1', runId: 'child-a', state: 'completed', completionReason: 'success',
    });
    await recordAuthoredChild(journal, 'root-1', { step: 'run-1', runId: 'child-a', state: 'admitted' });

    expect(await readAuthoredStepIndex(journal, 'root-1')).toEqual([
      expect.objectContaining({ state: 'completed', completionReason: 'success' }),
    ]);
  });

  it('keeps the kernel step id only when it differs from the authored one', async () => {
    const { journal } = streams();
    await recordAuthoredChild(journal, 'root-1', {
      step: 'run-1', runId: 'a', state: 'completed', completionReason: 'success', kernelStep: 'run-1',
    });
    await recordAuthoredChild(journal, 'root-1', {
      step: 'agent-2', runId: 'b', state: 'completed', completionReason: 'gate_failed', kernelStep: 'agent-2.gate',
    });

    const index = await readAuthoredStepIndex(journal, 'root-1');
    expect(index.find(record => record.step === 'run-1')).not.toHaveProperty('kernelStep');
    expect(index.find(record => record.step === 'agent-2')?.kernelStep).toBe('agent-2.gate');
  });

  it('bounds each field of each record rather than one aggregate index', async () => {
    const { journal, stored, key } = streams();
    const long = 'x'.repeat(4000);

    for (let i = 0; i < 40; i++) {
      await recordAuthoredChild(journal, 'root-1', {
        step: `run-${i}`, runId: `child-${i}`, state: 'completed', completionReason: long,
      });
    }

    const records = stored.get(key('root-1', AUTHORED_STEP_STREAM)) as Array<Record<string, string>>;
    expect(records).toHaveLength(40);
    for (const record of records) {
      expect(record['completionReason']!.length).toBeLessThanOrEqual(257);
    }
    // Forty bounded records still total far more than the 2,000 characters a
    // `verification.detail` render can hold — which is exactly why the index
    // lives in the stream and not in a completion output. No record is
    // dropped to keep an aggregate under a cap.
    expect(JSON.stringify(records).length).toBeGreaterThan(2000);
    expect(await readAuthoredStepIndex(journal, 'root-1')).toHaveLength(40);
  });

  it('bounds a single oversized field without dropping the record', async () => {
    const { journal } = streams();
    await recordAuthoredChild(journal, 'root-1', {
      step: 'run-1', runId: 'x'.repeat(4000), state: 'admitted',
    });

    const [record] = await readAuthoredStepIndex(journal, 'root-1');
    expect(record?.step).toBe('run-1');
    expect(record!.runId.length).toBe(257);
    expect(record!.runId.endsWith('…')).toBe(true);
  });

  it('pages until the stream is exhausted rather than reading one page', async () => {
    const { journal } = streams();
    for (let i = 0; i < 2500; i++) {
      await recordAuthoredChild(journal, 'root-1', {
        step: `run-${i}`, runId: `child-${i}`, state: 'completed', completionReason: 'success',
      });
    }

    // A single `stream.read` is capped at 1,000; a body with more operations
    // than that must still be fully discoverable.
    expect(await readAuthoredStepIndex(journal, 'root-1')).toHaveLength(2500);
  });

  it('ignores stream messages that are not index records', async () => {
    const { journal } = streams();
    // The root's stream carries the authored body's own traffic too.
    await journal.streamAppend('root-1', AUTHORED_STEP_STREAM, { hello: 'from the body' });
    await journal.streamAppend('root-1', AUTHORED_STEP_STREAM, 'a bare string');
    await journal.streamAppend('root-1', AUTHORED_STEP_STREAM, { index: 'relayflows.authored-step.v2', step: 'x' });
    await recordAuthoredChild(journal, 'root-1', { step: 'run-1', runId: 'a', state: 'admitted' });

    expect(await readAuthoredStepIndex(journal, 'root-1')).toEqual([
      expect.objectContaining({ step: 'run-1' }),
    ]);
  });

  it('writes nothing when there is no root to write to', async () => {
    const { journal, stored } = streams();
    await recordAuthoredChild(journal, undefined, { step: 'run-1', runId: 'a', state: 'admitted' });
    expect(stored.size).toBe(0);
  });
});

describe('a failed index append', () => {
  const broken = {
    async streamAppend() { throw new Error('run is no longer mutable'); },
  } as unknown as JournalClient;

  it('fails the operation when the record is the operation', async () => {
    // Rule 4: a journal write that fails fails the step. Nothing here is
    // allowed to decide on its own that the evidence was optional.
    await expect(recordAuthoredChild(broken, 'root-1', {
      step: 'run-1', runId: 'a', state: 'admitted',
    })).rejects.toThrow('run is no longer mutable');
  });

  it('surfaces alongside an existing failure instead of replacing it', async () => {
    // On the failure path the original failure is the answer the operator
    // came for. The persistence error is appended to it, never swapped for it.
    const appended = await alsoRecord(broken, 'root-1', {
      step: 'run-1', runId: 'a', state: 'completed', completionReason: 'retries_exhausted',
    });

    expect(appended).toContain('Could not persist the step index');
    expect(appended).toContain('run is no longer mutable');
  });

  it('appends nothing when the record succeeds', async () => {
    const { journal } = streams();
    expect(await alsoRecord(journal, 'root-1', {
      step: 'run-1', runId: 'a', state: 'completed', completionReason: 'success',
    })).toBe('');
  });
});

describe('the DAG fields on an index record', () => {
  it('round-trips a label and its predecessors on admitted and completed records', async () => {
    const { journal, stored, key } = streams();
    const edges = { label: 'writer', after: ['run-1', 'run-2'] };
    await recordAuthoredChild(journal, 'root-1', { step: 'agent-3', runId: 'c', state: 'admitted', ...edges });
    await recordAuthoredChild(journal, 'root-1', {
      step: 'agent-3', runId: 'c', state: 'completed', completionReason: 'success', ...edges,
    });

    expect(stored.get(key('root-1', AUTHORED_STEP_STREAM))).toEqual([
      { index: 'relayflows.authored-step.v1', step: 'agent-3', runId: 'c', state: 'admitted', ...edges },
      {
        index: 'relayflows.authored-step.v1', step: 'agent-3', runId: 'c', state: 'completed',
        completionReason: 'success', ...edges,
      },
    ]);
    expect(await readAuthoredStepIndex(journal, 'root-1')).toEqual([{
      index: 'relayflows.authored-step.v1', step: 'agent-3', runId: 'c',
      state: 'completed', completionReason: 'success', ...edges,
    }]);
  });

  it('writes no DAG fields for a step that has none, so old readers see the old shape', async () => {
    const { journal, stored, key } = streams();
    await recordAuthoredChild(journal, 'root-1', { step: 'run-1', runId: 'a', state: 'admitted' });
    expect(stored.get(key('root-1', AUTHORED_STEP_STREAM))).toEqual([{
      index: 'relayflows.authored-step.v1', step: 'run-1', runId: 'a', state: 'admitted',
    }]);
  });

  it('omits an oversized label rather than cutting it, and caps the predecessor list', async () => {
    const { journal, stored, key } = streams();
    const after = Array.from({ length: 40 }, (_, i) => `run-${i + 1}`);
    await recordAuthoredChild(journal, 'root-1', {
      step: 'agent-41', runId: 'x', state: 'admitted', label: 'l'.repeat(4000), after,
    });

    // A cut label could end mid-secret, where a whole-value redactor cannot
    // match it; so no prefix of it is ever written.
    expect(JSON.stringify(stored.get(key('root-1', AUTHORED_STEP_STREAM)))).not.toContain('lll');
    const [record] = await readAuthoredStepIndex(journal, 'root-1');
    expect(record).not.toHaveProperty('label');
    expect(record!.after).toEqual(after.slice(0, 32));
    expect(record!.afterTruncated).toBe(true);
  });

  it('skips a record whose DAG fields are malformed rather than trusting them', async () => {
    const { journal } = streams();
    const base = { index: 'relayflows.authored-step.v1', runId: 'a', state: 'admitted' };
    await journal.streamAppend('root-1', AUTHORED_STEP_STREAM, { ...base, step: 'run-1', label: 7 });
    await journal.streamAppend('root-1', AUTHORED_STEP_STREAM, { ...base, step: 'run-0', label: 'l'.repeat(257) });
    await journal.streamAppend('root-1', AUTHORED_STEP_STREAM, { ...base, step: 'run-2', after: 'run-1' });
    await journal.streamAppend('root-1', AUTHORED_STEP_STREAM, { ...base, step: 'run-3', after: [''] });
    await journal.streamAppend('root-1', AUTHORED_STEP_STREAM, { ...base, step: 'run-4', afterTruncated: 'yes' });
    // Longer than any writer produces: the list is bounded on read as on write.
    await journal.streamAppend('root-1', AUTHORED_STEP_STREAM, {
      ...base, step: 'run-5', after: Array.from({ length: 33 }, (_, i) => `run-${i}`),
    });
    await journal.streamAppend('root-1', AUTHORED_STEP_STREAM, {
      ...base, step: 'run-6', after: Array.from({ length: 32 }, (_, i) => `run-${i}`),
    });

    expect((await readAuthoredStepIndex(journal, 'root-1')).map((record) => record.step)).toEqual(['run-6']);
  });
});
