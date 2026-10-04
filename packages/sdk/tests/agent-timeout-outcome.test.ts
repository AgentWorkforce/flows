import { describe, expect, it, vi } from 'vitest';
import { authoredWorkerRunner } from '../src/authored-worker-step.js';
import { JournalClient } from '../src/journal-client.js';
import { compileSpec } from '../src/compile.js';

const mocks = vi.hoisted(() => ({ classify: vi.fn() }));
vi.mock('../src/cli/run.js', () => ({ classifyOutcome: mocks.classify }));
vi.mock('../src/authored-preflight.js', () => ({
  authoredPreflight: () => async (spec: unknown) => ({ report: { ok: true }, flow: compileSpec(spec) }),
}));

function setup(reason = 'timeout') {
  const journal = new JournalClient('/unused');
  vi.spyOn(journal, 'runStart').mockResolvedValue({ run_id: 'child', status: 'failed', completed_steps: 0 });
  const append = vi.spyOn(journal, 'streamAppend').mockResolvedValue({ offset: 0 } as never);
  mocks.classify.mockResolvedValue({ exitCode: 1, report: { status: 'failed', completionReason: 'step_failed',
    diagnostics: [{ stepId: 'a', stepType: 'agent', completionReason: reason, stderrTail: 'deadline' }] } });
  const runner = authoredWorkerRunner({ name: 'test' }, journal, '/flow.ts', [], {},
    undefined, undefined, undefined, 'root');
  return { runner, append, journal };
}

describe('recoverable agent timeout boundaries', () => {
  it('refuses an undeclared timeout and other failures', async () => {
    await expect(setup().runner.agent('a', { task: 'repair' })).rejects.toMatchObject({ code: 'step_failed' });
    await expect(setup('worker_error').runner.agent('a', { task: 'repair', timeout: '1s' }))
      .rejects.toMatchObject({ code: 'step_failed' });
  });
  it('does not bypass a lowered named gate that never ran', async () => {
    await expect(setup().runner.agent('a', { task: 'repair', timeout: '1s' },
      { type: 'artifact_exists', path: 'work.txt' })).rejects.toMatchObject({ code: 'step_failed' });
  });
  it('fails closed if the completed timeout cannot be indexed', async () => {
    const { runner, append } = setup();
    append.mockResolvedValueOnce({ offset: 0 } as never).mockRejectedValueOnce(new Error('disk full'));
    await expect(runner.agent('a', { task: 'repair', timeout: '1s' })).rejects.toThrow('disk full');
  });
  it('lowers a duration and resolves the journaled timeout exactly once', async () => {
    const { runner, append, journal } = setup();
    await expect(runner.agent('a', { task: 'repair', timeout: '45m' }))
      .resolves.toEqual({ summary: 'deadline', artifacts: [], completionReason: 'timeout' });
    expect(journal.runStart).toHaveBeenCalledWith(expect.objectContaining({
      steps: [expect.objectContaining({ timeout_ms: 2700000 })],
    }), undefined, expect.any(String));
    expect(append).toHaveBeenCalledTimes(2);
  });
  it.each([{ transport: 'relay' as const }, { maxIterations: 2 }])('refuses %j before admission', async options => {
    const { runner, journal } = setup();
    await expect(runner.agent('a', { task: 'repair', timeout: '1s', ...options }))
      .rejects.toMatchObject({ code: 'agent_cli_unresolved' });
    expect(journal.runStart).not.toHaveBeenCalled();
  });
});
