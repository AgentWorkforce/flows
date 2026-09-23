import { rmSync } from 'node:fs';
import type { Server } from 'node:net';
import { flow } from '@relayflows/surface';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { completionMarker, isLoweredCompletion } from '../src/authored-completion.js';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { authoredCompletion, type RunReport } from '../src/cli/run.js';
import { JournalClient } from '../src/journal-client.js';
import {
  kernelDialectError,
  sendOk,
  sendResult,
  sockPath,
  startLoopback,
} from './journal-client-loopback.js';

// The exact URL shape the production run had already produced before it died.
const PR_URL = 'https://github.com/AgentWorkforce/cloud-e2e-sandbox/pull/25';
const STEP_FAILED_MARKER = `printf '%s' '{"completionReason":"step_failed"}'`;
const NEEDS_HUMAN_MARKER = `printf '%s' '{"completionReason":"needs_human"}'`;

describe('authored done("step_failed") lowering', () => {
  let path: string;
  let server: Server;
  let nextRun = 1;
  const startedSpecs: Record<string, unknown>[] = [];
  const stepByRun = new Map<string, { id: string; command: string }>();

  beforeAll(() => {
    path = sockPath();
    server = startLoopback(path, {
      hello: (ctx) => sendOk(ctx),
      'run.start': (ctx, params) => {
        const error = kernelDialectError(params.spec);
        if (error !== null) {
          ctx.send({ id: ctx.id, ok: false, error: { code: 'invalid_spec', message: error } });
          return;
        }
        const spec = params.spec as Record<string, unknown>;
        const step = (spec['steps'] as Record<string, unknown>[])[0]!;
        const runId = `step-failed-run-${nextRun++}`;
        startedSpecs.push(spec);
        stepByRun.set(runId, { id: step['id'] as string, command: step['command'] as string });
        // Every lowered step here succeeds: this suite is about a flow whose
        // work ran correctly and whose BODY declared the adverse verdict.
        sendResult(ctx, {
          run_id: runId, status: 'completed', completion_reason: 'success', completed_steps: 1,
        });
      },
      'journal.read': (ctx, params) => {
        const step = stepByRun.get(params.run_id as string)!;
        sendResult(ctx, {
          entries: [{
            entry_type: 'step.completed',
            step_id: step.id,
            payload: {
              completionReason: 'success',
              output: { exit_code: 0, stdout_tail: outputFor(step.command), stderr_tail: '' },
            },
          }],
        });
      },
    });
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(path, { force: true });
  });

  async function connected(name: string): Promise<JournalClient> {
    const client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello(name);
    return client;
  }

  it('lowers done("step_failed") rather than refusing it as unsupported_completion', async () => {
    const handle = flow('review-found-problems', async (f) => {
      await f.run('printf no');
      f.done('step_failed');
    });
    const client = await connected('step-failed');

    try {
      const result = await executeAuthoredFlow(handle, client);

      expect(result.completionReason).toBe('step_failed');
      // Every lowered step, the terminal marker included, SUCCEEDED. The
      // verdict is data the body declared, not a step that failed — lowering
      // it as a failing command would put fabricated evidence in the journal.
      expect(result.journalSteps.map((step) => step.completionReason)).toEqual(['success', 'success']);
      expect(result.journalSteps.at(-1)!.id).toBe('complete-2');
    } finally {
      client.close();
    }
  });

  it('records the verdict as a deterministic marker step in the journal', async () => {
    startedSpecs.length = 0;
    const handle = flow('marker', async (f) => {
      f.done('step_failed');
    });
    const client = await connected('step-failed-marker');

    try {
      await executeAuthoredFlow(handle, client);

      expect(startedSpecs).toHaveLength(1);
      expect(startedSpecs[0]).toMatchObject({
        name: 'marker/complete-1',
        steps: [{ id: 'complete-1', type: 'deterministic', command: STEP_FAILED_MARKER }],
      });
    } finally {
      client.close();
    }
  });

  it('keeps a pull request opened before the verdict readable in the journal', async () => {
    startedSpecs.length = 0;
    let captured = '';
    const handle = flow('opened-a-pr', async (f) => {
      captured = await f.run(`emit:${PR_URL}`);
      f.done('step_failed');
    });
    const client = await connected('step-failed-pr');

    try {
      const result = await executeAuthoredFlow(handle, client);

      expect(captured).toBe(PR_URL);
      expect(result.completionReason).toBe('step_failed');
      // The PR-opening step remains a recorded, successful journal step with
      // its own run id. An adverse verdict truncates nothing before it.
      expect(result.journalSteps).toHaveLength(2);
      expect(result.journalSteps[0]).toMatchObject({ id: 'run-1', completionReason: 'success' });
      expect(startedSpecs[0]).toMatchObject({
        steps: [{ id: 'run-1', command: `emit:${PR_URL}` }],
      });
    } finally {
      client.close();
    }
  });

  it.each([
    ['success', ':'],
    ['needs_human', NEEDS_HUMAN_MARKER],
  ] as const)('still lowers done("%s") exactly as before', async (reason, command) => {
    startedSpecs.length = 0;
    const handle = flow(`unchanged-${reason}`, async (f) => {
      f.done(reason);
    });
    const client = await connected(`unchanged-${reason}`);

    try {
      const result = await executeAuthoredFlow(handle, client);

      expect(result.completionReason).toBe(reason);
      expect(startedSpecs[0]).toMatchObject({
        steps: [{ id: 'complete-1', type: 'deterministic', command }],
      });
    } finally {
      client.close();
    }
  });

  it.each(['canceled', 'budget_exceeded'] as const)(
    'refuses done("%s") as a kernel outcome no body can declare',
    async (reason) => {
      const handle = flow(`kernel-owned-${reason}`, async (f) => {
        f.done(reason);
      });
      const client = await connected(`kernel-owned-${reason}`);

      try {
        await expect(executeAuthoredFlow(handle, client)).rejects.toMatchObject({
          code: 'unsupported_completion',
          completionReason: reason,
        });
      } finally {
        client.close();
      }
    },
  );

  it('answers "which completions lower?" from one place', () => {
    // The defect this fixes was two gates disagreeing: `step_failed` passed
    // the vocabulary check and died at a second, hand-written one.
    expect(isLoweredCompletion('success')).toBe(true);
    expect(isLoweredCompletion('needs_human')).toBe(true);
    expect(isLoweredCompletion('step_failed')).toBe(true);
    expect(isLoweredCompletion('canceled')).toBe(false);
    expect(isLoweredCompletion('budget_exceeded')).toBe(false);
    expect(completionMarker('success')).toBe(':');
    expect(completionMarker('needs_human')).toBe(NEEDS_HUMAN_MARKER);
    expect(completionMarker('step_failed')).toBe(STEP_FAILED_MARKER);
  });
});

describe('the report a lowered completion produces for run and resume', () => {
  const base: RunReport = { ok: false, command: 'resume', resolutions: [], diagnostics: [] };
  const result = (completionReason: 'success' | 'needs_human' | 'step_failed') =>
    ({ name: 'software-factory', completionReason, journalSteps: [{}, {}] });

  it('maps step_failed to exit 1 and a failed run, on resume as well as run', () => {
    const execution = authoredCompletion('resume', base, '/sock', result('step_failed'), 'root-run');

    expect(execution.exitCode).toBe(1);
    expect(execution.report.status).toBe('failed');
    expect(execution.report.ok).toBe(false);
    expect(execution.report.completionReason).toBe('step_failed');
    expect(execution.report.runId).toBe('root-run');
    expect(execution.report.completedSteps).toBe(2);
    expect(execution.report.diagnostics.map((d) => d.kind)).toContain('step_failed');
  });

  it('leaves success and needs_human on the exits they already had', () => {
    const success = authoredCompletion('resume', base, '/sock', result('success'), 'r');
    expect(success.exitCode).toBe(0);
    expect(success.report.ok).toBe(true);
    expect(success.report.status).toBe('completed');
    expect(success.report.completionReason).toBe('success');

    const parked = authoredCompletion('resume', base, '/sock', result('needs_human'), 'r');
    expect(parked.exitCode).toBe(3);
    expect(parked.report.ok).toBe(false);
    expect(parked.report.status).toBe('parked');
    expect(parked.report.diagnostics.map((d) => d.kind)).toContain('run_parked');
  });
});

function outputFor(command: string): string {
  return command.startsWith('emit:') ? command.slice('emit:'.length) : '';
}
