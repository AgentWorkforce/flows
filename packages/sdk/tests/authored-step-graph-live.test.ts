import { afterEach, describe, expect, it } from 'vitest';
import { flow } from '@relayflows/surface';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { attachLocalAgent } from '../src/local-agent.js';
import { AUTHORED_STEP_STREAM, readAuthoredStepIndex } from '../src/authored-step-index.js';
import type { JournalClient } from '../src/journal-client.js';
import { chainFixture } from './flow-chain-fixture.js';

const closes: Array<() => Promise<void>> = [];
// Every close runs even when an earlier one rejects, so a failed agent close never leaks the daemon.
afterEach(async () => {
  const errors: unknown[] = [];
  for (const close of closes.splice(0).reverse()) {
    try { await close(); } catch (error) { errors.push(error); }
  }
  if (errors.length > 0) throw errors[0];
});

/** A mutable root the index is appended to, as in authored-run-failure-evidence.test.ts. */
async function openRoot(journal: JournalClient): Promise<string> {
  const outcome = await journal.runStart({
    version: '0.1.0',
    name: 'graph-root',
    steps: [{
      id: 'authored-root', type: 'agent', instruction: '{}',
      surfaces: { streams: [{ stream: 'graph-root-stream' }] },
      recovery_mode: 'reset', max_iterations: 8,
    }],
  } as never);
  return outcome.run_id;
}

describe('the authored step DAG through the live kernel', () => {
  it('carries labels and predecessors on every index record and journal step, ids unchanged', async () => {
    const fixture = chainFixture('drafted');
    closes.push(() => fixture.close());
    const journal = await fixture.connect();
    const agent = await attachLocalAgent(journal);
    closes.push(() => agent.close());
    const rootRunId = await openRoot(journal);

    const handle = flow('graph-live', async (f) => {
      await f.run('printf plan');
      // Fan out on deterministic steps: the local agent worker serves one lease
      // at a time, so parallel agents would park rather than run.
      await Promise.all([f.run('printf left'), f.run('printf right')]);
      await f.agent('writer', { task: 'write it' });
      await f.run('printf done');
      f.done('success');
    });
    const result = await executeAuthoredFlow(handle, journal, undefined, {
      rootRunId, flowPath: fixture.flowPath, localAgentStream: agent.stream, dataDir: fixture.data,
    });

    // Step identity is the kernel's and the admission key's: unchanged.
    expect(result.journalSteps.map((step) => step.id).sort()).toEqual(
      ['agent-4', 'complete-6', 'run-1', 'run-2', 'run-3', 'run-5'],
    );
    const expected = {
      // `f.run` has no label: a command is not a safe display name.
      'run-1': {},
      'run-2': { after: ['run-1'] },
      'run-3': { after: ['run-1'] },
      'agent-4': { label: 'writer', after: ['run-2', 'run-3'] },
      'run-5': { after: ['agent-4'] },
    };
    const journaled = Object.fromEntries(result.journalSteps.map((step) => [step.id, step]));
    for (const [step, edges] of Object.entries(expected)) {
      expect(journaled[step]).toEqual({ id: step, runId: expect.any(String), completionReason: 'success', ...edges });
    }
    // The terminal marker is not an authored step and carries no graph fields.
    expect(journaled['complete-6']).not.toHaveProperty('label');
    expect(journaled['complete-6']).not.toHaveProperty('after');

    // Both the `admitted` and the `completed` record carry the fields, so a
    // reader watching a run in flight can draw the DAG before anything finishes.
    const raw = (await journal.streamRead(rootRunId, AUTHORED_STEP_STREAM, 0, 1000)).messages
      .map((message) => (message as { message?: unknown }).message ?? message) as Array<Record<string, unknown>>;
    for (const [step, edges] of Object.entries(expected)) {
      const records = raw.filter((record) => record['step'] === step);
      expect(records.map((record) => record['state']).sort()).toEqual(['admitted', 'completed']);
      for (const record of records) expect(record).toMatchObject(edges);
    }

    const index = await readAuthoredStepIndex(journal, rootRunId);
    expect(Object.fromEntries(index.map((record) => [record.step, record]))).toEqual(
      // The terminal marker is indexed too, with no graph fields of its own.
      Object.fromEntries(Object.entries({ ...expected, 'complete-6': {} }).map(([step, edges]) => [step, {
        index: 'relayflows.authored-step.v1', step, runId: journaled[step]!.runId,
        state: 'completed', completionReason: 'success', ...edges,
      }])),
    );
  }, 60_000);
});
