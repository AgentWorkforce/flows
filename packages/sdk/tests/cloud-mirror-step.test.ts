import { describe, expect, it } from 'vitest';
import {
  fitSnapshot, identifier, label, mirrorJournal, snapshotStepStatus, withGraphHints,
  IDENTIFIER_MAX_CHARS, LABEL_MAX_CHARS, SNAPSHOT_MAX_BYTES, SNAPSHOT_MAX_STEPS,
} from '../src/cloud-mirror-step.js';
import type { JournalEvent } from '../src/journal-reader.js';

let seq = 0;
function entry(partial: Partial<JournalEvent> & { entry_type: string }): JournalEvent {
  seq += 1;
  return {
    seq,
    segment_id: 1,
    run_id: '01RUN',
    step_id: null,
    attempt: null,
    at_ms: 1_700_000_000_000 + seq * 1_000,
    payload: null,
    ...partial,
  };
}

/** A two-step declarative run: one agent step that retried once, then a gate. */
function journal(): JournalEvent[] {
  seq = 0;
  return [
    entry({
      entry_type: 'run.spawned',
      payload: {
        spec: {
          name: 'review',
          steps: [
            { id: 'write', type: 'agent', after: [] },
            { id: 'verify', type: 'deterministic', after: ['write'] },
          ],
        },
      },
    }),
    entry({ entry_type: 'step.attempt.started', step_id: 'write', attempt: 1, payload: { lease_deadline_ms: 1 } }),
    entry({
      entry_type: 'step.completed',
      step_id: 'write',
      attempt: 1,
      payload: {
        completionReason: 'agent_error',
        disposition: 'retry',
        next_attempt_at_ms: 1_700_000_004_000,
        budget: { tokens_in: 10, tokens_out: 5, dollars: '0.01' },
        trajectory_tail: {
          transcript: {
            file: { path: '/home/dev/.relayflowd/runs/01RUN/steps/write/attempt-1.transcript.jsonl', bytes_kept: 40, truncated: false },
            result: { model: 'claude-opus-5', num_turns: 2, total_cost_usd: 0.02 },
            failure: { kind: 'result', excerpt: 'the tool call failed' },
          },
        },
      },
    }),
    entry({ entry_type: 'step.attempt.started', step_id: 'write', attempt: 2, payload: { lease_deadline_ms: 1 } }),
    entry({
      entry_type: 'step.completed',
      step_id: 'write',
      attempt: 2,
      payload: {
        completionReason: 'success',
        disposition: 'step_done',
        budget: { tokens_in: 20, tokens_out: 7, dollars: '0.03' },
        output: { artifacts: ['out/report.md'] },
        trajectory_tail: {
          transcript: {
            file: { path: '/home/dev/.relayflowd/runs/01RUN/steps/write/attempt-2.transcript.jsonl', bytes_kept: 90, truncated: false },
            result: { model: 'claude-opus-5', num_turns: 5, total_cost_usd: 0.05 },
            tools: { total_calls: 7, counts: [], last_calls: [], shown_calls: 0, complete: true },
          },
        },
      },
    }),
    entry({ entry_type: 'step.attempt.started', step_id: 'verify', attempt: 1, payload: { lease_deadline_ms: 1 } }),
  ];
}

describe('mirrorJournal', () => {
  it('publishes a live view and a final row for every step the journal shows', () => {
    const mirrored = mirrorJournal('01RUN', journal(), 1_700_000_010_000, {});

    expect(mirrored.status).toBe('running');
    expect(mirrored.terminal).toBe(false);
    expect(mirrored.steps.map(step => [step.stepName, step.state])).toEqual([
      ['write', 'done'],
      ['verify', 'running'],
    ]);
    // Only the finished step is reported as final; a running one has no outcome.
    expect(mirrored.finals).toHaveLength(1);
    expect(mirrored.finals[0]).toMatchObject({
      stepName: 'write',
      stepType: 'agent',
      status: 'completed',
      completionReason: 'success',
      exitCode: 0,
      // Two attempts ran, so one was a retry.
      retryCount: 1,
      model: 'claude-opus-5',
      // Summed across attempts, not taken from the last one.
      tokensInput: 30,
      tokensOutput: 12,
      costUsd: 0.05,
      // Named after the transcript object only once one is uploaded.
      sandboxId: '',
    });
  });

  it('carries the whole attempt roster in detail, and no local path with it', () => {
    const [step] = mirrorJournal('01RUN', journal(), 1_700_000_010_000, {}).finals;
    const detail = step!.detail as { attempts: unknown[]; transcript: { file: Record<string, unknown> } };

    expect(detail.attempts).toHaveLength(2);
    expect(detail.attempts[0]).toMatchObject({ attempt: 1, completionReason: 'agent_error', disposition: 'retry' });
    // The digest's byte counts are useful; the path names a file on this
    // machine that no dashboard reader can open.
    expect(detail.transcript.file).toMatchObject({ bytes_kept: 90 });
    expect(detail.transcript.file).not.toHaveProperty('path');
    expect(JSON.stringify(detail)).not.toContain('/home/dev');
  });

  it('names every attempt transcript on disk, in attempt order', () => {
    const { transcripts } = mirrorJournal('01RUN', journal(), 1_700_000_010_000, {});
    expect(transcripts).toEqual([{
      stepName: 'write',
      attempts: [
        { attempt: 1, path: '/home/dev/.relayflowd/runs/01RUN/steps/write/attempt-1.transcript.jsonl' },
        { attempt: 2, path: '/home/dev/.relayflowd/runs/01RUN/steps/write/attempt-2.transcript.jsonl' },
      ],
    }]);
  });

  it('reports a failed step with its own failure excerpt, redacted', () => {
    const events = journal().slice(0, 3);
    events[2] = entry({
      ...events[2]!,
      payload: {
        ...(events[2]!.payload as Record<string, unknown>),
        disposition: 'step_done',
        trajectory_tail: {
          transcript: {
            result: { model: 'claude-opus-5' },
            failure: { kind: 'result', excerpt: 'refused: Bearer sk-ant-abcdefghijkl' },
          },
        },
      },
    });
    const [step] = mirrorJournal('01RUN', events, 1_700_000_010_000, {}).finals;

    expect(step).toMatchObject({ status: 'failed', exitCode: 1, completionReason: 'agent_error' });
    expect(step!.error).toContain('[redacted]');
    expect(step!.error).not.toContain('sk-ant-abcdefghijkl');
  });

  it('never publishes the authored root as a step of its own flow', () => {
    seq = 0;
    const events = [
      entry({
        entry_type: 'run.spawned',
        payload: { spec: { name: 'authored', steps: [{ id: 'authored-root', type: 'deterministic', after: [] }] } },
      }),
      entry({ entry_type: 'step.attempt.started', step_id: 'authored-root', attempt: 1, payload: {} }),
    ];
    expect(mirrorJournal('01ROOT', events, 1_700_000_010_000, {}).steps).toEqual([]);
  });

  it('reads the child journals and graph edges out of an authored root index', () => {
    seq = 0;
    const events = [
      entry({ entry_type: 'run.spawned', payload: { spec: { name: 'authored', steps: [] } } }),
      entry({
        entry_type: 'stream.appended',
        payload: {
          stream: 'authored-steps',
          message: { index: 'relayflows.authored-step.v1', step: 'review', runId: '01CHILD', state: 'admitted', label: 'Review the PR' },
        },
      }),
      entry({
        entry_type: 'stream.appended',
        payload: {
          stream: 'authored-steps',
          // A completion record that carries no label must not erase the one
          // the admission carried.
          message: { index: 'relayflows.authored-step.v1', step: 'review', runId: '01CHILD', state: 'completed', completionReason: 'success', after: ['plan'] },
        },
      }),
    ];
    const mirrored = mirrorJournal('01ROOT', events, 1_700_000_010_000, {});

    expect(mirrored.children).toEqual(['01CHILD']);
    expect(mirrored.hints.get('01CHILD/review')).toEqual({ label: 'Review the PR', after: ['plan'] });
  });
});

describe('the bounds Cloud enforces', () => {
  it('redacts before it clips, so no secret survives as a prefix', () => {
    const secret = 'sk-ant-0123456789abcdefghijklmnopqrstuvwxyz';
    expect(identifier(secret, {})).not.toContain('sk-ant-0123');
    expect(identifier('a'.repeat(400), {})).toHaveLength(IDENTIFIER_MAX_CHARS);
    // `[redacted]` is not identifier-shaped, so it is normalized rather than dropped.
    expect(identifier(secret, {})).toMatch(/^[A-Za-z0-9_.:/-]+$/u);
  });

  it('normalizes a label the way workflow_steps.display_name is normalized', () => {
    expect(label('  Review   the   PR \n', {})).toBe('Review the PR');
    expect(label('', {})).toBeUndefined();
    expect(label('x'.repeat(400), {})?.length).toBe(LABEL_MAX_CHARS);
  });

  it('derives a live step status the final report will agree with', () => {
    expect(snapshotStepStatus({ state: 'running' })).toBe('running');
    expect(snapshotStepStatus({ state: 'done', completionReason: 'success' })).toBe('completed');
    expect(snapshotStepStatus({ state: 'done', completionReason: 'agent_error' })).toBe('failed');
    // A `done` step whose reason is missing is NOT quietly called a success.
    expect(snapshotStepStatus({ state: 'done' })).toBe('failed');
  });

  it('caps a long run to its live tail and says how many steps it left out', () => {
    const steps = Array.from({ length: SNAPSHOT_MAX_STEPS + 10 }, (_unused, index) => ({
      stepName: `step-${index}`,
      journalRunId: '01RUN',
      stepType: 'agent',
      state: 'done' as const,
      attempt: 1,
      elapsedMs: 1,
    }));
    const snapshot = fitSnapshot(steps, { sequence: 1, capturedAt: '2026-09-24T00:00:00.000Z' });

    expect(snapshot.steps).toHaveLength(SNAPSHOT_MAX_STEPS);
    expect(snapshot.steps[0]!.stepName).toBe('step-10');
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.omittedStepCount).toBe(10);
  });

  it('sheds artifact names before whole steps to fit the byte cap', () => {
    const steps = Array.from({ length: SNAPSHOT_MAX_STEPS }, (_unused, index) => ({
      stepName: `step-${index}`,
      journalRunId: '01RUN',
      stepType: 'agent',
      state: 'done' as const,
      attempt: 1,
      elapsedMs: 1,
      artifacts: Array.from({ length: 5 }, (_u, a) => `out/${'p'.repeat(190)}-${index}-${a}`),
    }));
    const snapshot = fitSnapshot(steps, { sequence: 2, capturedAt: '2026-09-24T00:00:00.000Z' });

    expect(Buffer.byteLength(JSON.stringify(snapshot), 'utf8')).toBeLessThanOrEqual(SNAPSHOT_MAX_BYTES);
    expect(snapshot.steps).toHaveLength(SNAPSHOT_MAX_STEPS);
    expect(snapshot.steps.every(step => step.artifacts === undefined)).toBe(true);
    expect(snapshot.truncated).toBe(true);
  });

  it('drops an edge to a step the report does not contain', () => {
    const hints = new Map([['01RUN/verify', { label: 'Verify', after: ['write', 'gone'] }]]);
    const applied = withGraphHints(
      { stepName: 'verify', journalRunId: '01RUN' }, hints, '01RUN', 32, new Set(['write', 'verify']),
    );
    expect(applied).toMatchObject({ label: 'Verify', dependsOn: ['write'] });
  });
});
