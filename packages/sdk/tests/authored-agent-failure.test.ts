import { flow } from '@relayflows/surface';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getAuthoredFlowDefinition } from '../src/authored-flow.js';
import type { AuthoredFlowJournalStep } from '../src/authored-flow-executor.js';
import { authoredWorkerRunner } from '../src/authored-worker-step.js';
import { classifyOutcome, type RunExecution } from '../src/cli/run.js';
import { JournalClient } from '../src/journal-client.js';
import { preflight } from '../src/preflight.js';

vi.mock('../src/cli/run.js', () => ({ classifyOutcome: vi.fn() }));
afterEach(() => vi.restoreAllMocks());

describe('authored agent failure contracts', () => {
  const report = { ok: true, gates: [], resolutions: [], diagnostics: [] };

  it.each([1, 3] as const)('preserves exit %s diagnostics despite a trailing warning', async exitCode => {
    const journal = new JournalClient('/unused');
    vi.spyOn(journal, 'runStart').mockResolvedValue({ run_id: 'run-1' } as never);
    const read = vi.spyOn(journal, 'journalRead');
    const journalSteps: AuthoredFlowJournalStep[] = [];
    const diagnostics: RunExecution['report']['diagnostics'] = [
      { severity: exitCode === 3 ? 'parked' : 'failure', kind: 'protocol_error', message: 'actual cause' },
      { severity: 'warning', kind: 'unprovable_effects', message: 'unrelated warning' },
    ];
    const lower = authoredWorkerRunner(
      getAuthoredFlowDefinition(flow('failure', {}, async f => f.done('success'))),
      journal, '/flow.ts', journalSteps, {}, undefined, undefined, undefined, undefined,
      {
        declarations: () => report,
        check: authored => ({ report, flow: { ...authored, cli: 'wrapper' } }),
      },
    );
    for (const entries of [diagnostics, []]) {
      vi.mocked(classifyOutcome).mockResolvedValue({
        exitCode, report: { ...report, ok: false, command: 'run', diagnostics: entries },
      });
      await expect(lower.agent('step-1', 'label', { task: 'Work.' })).rejects.toMatchObject({
        code: exitCode === 3 ? 'agent_parked' : 'step_failed',
        runId: 'run-1',
        message: expect.stringContaining(entries.length ? 'actual cause' : 'flow "failure" step "step-1"'),
      });
    }
    expect(read).not.toHaveBeenCalled();
    expect(journalSteps).toEqual([]);
  });

  it('retains a real completion when output decoding refuses, but never invents a missing completion', async () => {
    const journal = new JournalClient('/unused');
    const journalSteps: AuthoredFlowJournalStep[] = [];
    vi.spyOn(journal, 'runStart').mockResolvedValue({ run_id: 'run-1' } as never);
    vi.spyOn(journal, 'journalRead').mockResolvedValueOnce({ entries: [{
      entry_type: 'step.completed', step_id: 'step-1',
      payload: { completionReason: 'success', output: null },
    }] } as never).mockResolvedValueOnce({ entries: [] } as never);
    vi.mocked(classifyOutcome).mockResolvedValue({
      exitCode: 0, report: { ...report, command: 'run', diagnostics: [] },
    });
    const lower = authoredWorkerRunner(
      getAuthoredFlowDefinition(flow('failure', {}, async f => f.done('success'))),
      journal, '/flow.ts', journalSteps, {}, undefined, undefined, undefined, undefined,
      { declarations: () => report, check: authored => ({ report, flow: { ...authored, cli: 'wrapper' } }) },
    );
    await expect(lower.agent('step-1', 'label', { task: 'Work.' }))
      .rejects.toMatchObject({ code: 'journal_protocol_violation' });
    expect(journalSteps).toEqual([{ id: 'step-1', runId: 'run-1', completionReason: 'success' }]);
    await expect(lower.agent('step-2', 'label', { task: 'Work.' }))
      .rejects.toMatchObject({ code: 'journal_protocol_violation' });
    expect(journalSteps).toHaveLength(1);
  });

  it.each([undefined, []])('refuses a present registry with models=%j before any CLI probe', models => {
    const cli = vi.fn();
    const result = preflight({
      version: '0.1.0', name: 'declarations',
      agents: { reviewer: { cli: 'wrapper', model: 'model-a' } },
      steps: [{ id: 'review', type: 'agent', agent: 'reviewer', instruction: 'Review.' }],
    }, { modelRegistryPath: '/project/flows.json', models,
      probes: { cli, executor: () => true, command: () => true } });
    expect(result).toMatchObject({ ok: false, diagnostics: [{ kind: 'model_unknown', agent: 'reviewer' }] });
    expect(cli).not.toHaveBeenCalled();
  });
});
