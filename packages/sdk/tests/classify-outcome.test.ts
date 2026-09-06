import { describe, expect, it } from 'vitest';

import { classifyOutcome } from '../src/cli/run.js';
import type { JournalClient } from '../src/journal-client.js';
import type { RunGetResult, RunOutcome } from '../src/protocol.js';

const RUN_ID = 'run-179';

const parked: RunOutcome = {
  run_id: RUN_ID,
  status: 'parked',
  completion_reason: null,
  completed_steps: 1,
};

const base = {
  command: 'run' as const,
  ok: true,
  specPath: 'spec.yaml',
  diagnostics: [],
};

/// A client that answers `run.get` from a scripted queue and always reports the
/// run as still parked on `run.resume` -- which is what the daemon does while a
/// worker completion is being driven.
function clientReturning(snapshots: RunGetResult[]): { client: JournalClient; resumes: () => number } {
  let index = 0;
  let resumes = 0;
  const fake = {
    runGet: async (): Promise<RunGetResult> =>
      snapshots[Math.min(index++, snapshots.length - 1)]!,
    runResume: async (): Promise<RunOutcome> => {
      resumes += 1;
      return parked;
    },
  };
  return { client: fake as unknown as JournalClient, resumes: () => resumes };
}

const runningNoStep: RunGetResult = {
  run_id: RUN_ID,
  status: 'running',
  steps: {},
  budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
};

const parkedOnLlm: RunGetResult = {
  run_id: RUN_ID,
  status: 'parked',
  steps: { answer: { type: 'llm', state: 'runnable' } as never },
  budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
};

describe('classifyOutcome', () => {
  /// #179. A run that reports `running` with no identifiable step is mid-stride,
  /// not broken: a worker has just completed the step the run parked on and the
  /// daemon has not yet driven what follows. Treating that instant as terminal
  /// failed healthy runs with `parked without a classifiable completion`.
  it('waits out a running run with no identifiable step instead of failing it', async () => {
    const { client, resumes } = clientReturning([
      runningNoStep,
      runningNoStep,
      runningNoStep,
      parkedOnLlm,
    ]);

    const execution = await classifyOutcome(client, 'run', parked, base as never, '/tmp/sock', {});

    expect(
      execution.report.diagnostics.map((d) => d.kind),
      JSON.stringify(execution.report.diagnostics),
    ).not.toContain('protocol_error');
    expect(execution.exitCode).toBe(3);
    expect(execution.report.parkedStep?.id).toBe('answer');
    expect(resumes()).toBeGreaterThan(0);
  });

  /// The bound must hold: a run that NEVER resolves still reports rather than
  /// polling forever. Fail closed is the point of keeping the original break.
  it('gives up and reports when a running run never becomes classifiable', async () => {
    const { client } = clientReturning([runningNoStep]);

    const execution = await classifyOutcome(client, 'run', parked, base as never, '/tmp/sock', {});

    expect(execution.exitCode).not.toBe(0);
    expect(execution.report.parkedStep).toBeUndefined();
  });
});
