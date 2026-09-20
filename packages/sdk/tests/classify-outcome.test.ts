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

const parkedOnAgent: RunGetResult = {
  run_id: RUN_ID,
  status: 'parked',
  steps: { work: { type: 'agent', state: 'runnable' } as never },
  budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
};

async function classifyPark(
  command: 'run' | 'resume',
  report: Partial<typeof base>,
  options: Record<string, unknown>,
): Promise<string> {
  const { client } = clientReturning([parkedOnAgent]);
  const execution = await classifyOutcome(
    client, command, parked, { ...base, ...report } as never, '/tmp/sock', options);
  expect(execution.exitCode).toBe(3);
  expect(execution.report.parkCause).toBe('worker_unavailable');
  return execution.report.diagnostics.at(-1)!.message;
}

describe('the remedy on a worker park', () => {
  /// The reported defect: the `command === 'run'` guard meant a parked resume
  /// printed "no worker is attached" and stopped there, so the obvious next
  /// move — resume WITH a worker — went unsaid. A spec run is resumable, so
  /// the remedy is this run, not a new one.
  it('tells a parked declarative resume to continue this run with a worker', async () => {
    const message = await classifyPark('resume', { specPath: 'spec.yaml' }, { dataDir: '/tmp/d' });
    expect(message).toContain(`flows resume --data-dir /tmp/d --local-agent ${RUN_ID}`);
    expect(message).not.toContain('flows run');
  });

  it('tells a parked declarative run to start a new one with a worker', async () => {
    const message = await classifyPark('run', { path: 'flows/hello.flow.yaml' }, { dataDir: '/tmp/d' });
    // The prefix that has always been emitted, unchanged, with the data dir
    // this invocation actually used appended.
    expect(message).toContain(`flows run --local-agent 'flows/hello.flow.yaml' --data-dir /tmp/d`);
  });

  /// An authored `.flow.ts` is silent HERE on purpose. This classifier runs
  /// once per authored child run and has no access to the `--input` a new run
  /// must repeat; `direct-run.ts` and `resumeFlow` render it once, where both
  /// are known. Appending here as well would also double the clause on resume.
  it('leaves the authored remedy to the boundary that knows the input', async () => {
    const message = await classifyPark('run', { path: 'flows/hello.flow.ts' }, { dataDir: '/tmp/d' });
    expect(message).not.toContain('--local-agent');
  });

  it('never tells someone who passed --local-agent to pass it again', async () => {
    const message = await classifyPark(
      'resume', { specPath: 'spec.yaml' }, { dataDir: '/tmp/d', localAgent: true });
    expect(message).toContain('no attached worker was eligible');
    expect(message).not.toMatch(/flows (run|resume)/);
  });
});
