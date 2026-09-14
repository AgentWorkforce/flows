import { existsSync, writeFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flow } from '@relayflows/surface';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import type { JournalClient } from '../src/journal-client.js';
import { chainFixture } from './flow-chain-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const close of cleanups.splice(0)) await close();
});

async function fixture() {
  const runtime = chainFixture('implementation finished');
  cleanups.push(() => runtime.close());
  return { ...runtime, client: await runtime.connect() };
}

async function expectMarker(client: JournalClient, runId: string, reason: string) {
  const { entries } = await client.journalRead(runId, 1);
  expect(entries).toContainEqual(expect.objectContaining({
    entry_type: 'step.completed',
    payload: expect.objectContaining({
      completionReason: 'success',
      output: expect.objectContaining({ stdout_tail: JSON.stringify({ completionReason: reason }) }),
    }),
  }));
  // The marker records the authored outcome; it does not forge a kernel failure.
  expect(entries).toContainEqual(expect.objectContaining({
    entry_type: 'run.completed',
    payload: expect.objectContaining({ completionReason: 'success' }),
  }));
}

describe('authored cancellation and rejection through the live journal', () => {
  it.each(['canceled', 'step_failed'] as const)('records done(%s) after awaited work', async reason => {
    const runtime = await fixture();
    const result = await executeAuthoredFlow(flow('completion', async f => {
      await f.run('printf checked');
      return f.done(reason);
    }), runtime.client);
    expect(result.completionReason).toBe(reason);
    expect(result.journalSteps).toHaveLength(2);
    await expectMarker(runtime.client, result.journalSteps.at(-1)!.runId, reason);
  });

  it.each(['canceled', 'step_failed'] as const)('refuses unawaited operations before done(%s)', async reason => {
    const runtime = await fixture();
    const start = vi.spyOn(runtime.client, 'runStart');
    await expect(executeAuthoredFlow(flow('unawaited', async f => {
      void f.run('printf unawaited');
      return f.done(reason);
    }), runtime.client)).rejects.toMatchObject({ code: 'unawaited_step' });
    expect(start.mock.calls.some(([spec]) => spec.steps.some(step => step.id.startsWith('complete-')))).toBe(false);
  });

  it.each(['canceled', 'step_failed'] as const)('fails closed if the done(%s) marker cannot be journaled', async reason => {
    const runtime = await fixture();
    const runStart = runtime.client.runStart.bind(runtime.client);
    vi.spyOn(runtime.client, 'runStart').mockImplementation(spec => {
      if (spec.steps.some(step => step.id.startsWith('complete-'))) throw new Error('terminal journal unavailable');
      return runStart(spec);
    });
    await expect(executeAuthoredFlow(flow('failed-marker', async f => {
      await f.run('printf checked');
      return f.done(reason);
    }), runtime.client)).rejects.toThrow('terminal journal unavailable');
  });

  it('keeps unsupported budget completion lowering closed', async () => {
    const runtime = await fixture();
    const start = vi.spyOn(runtime.client, 'runStart');
    await expect(executeAuthoredFlow(flow('unsupported', async f => f.done('budget_exceeded')), runtime.client))
      .rejects.toMatchObject({ code: 'unsupported_completion' });
    expect(start).not.toHaveBeenCalled();
  });

  it('reports an explicit cancellation through the built CLI without starting an agent', async () => {
    const runtime = await fixture();
    writeFileSync(runtime.flowPath, `import { flow } from '@relayflows/surface';
export default flow<{ cancellationRequested: boolean }>('cancel-work', async (f, input) => {
  if (input.cancellationRequested) return f.done('canceled');
  await f.agent('implementer', { task: 'Implement the requested change.' });
  return f.done('success');
});
`);
    const invoked = runtime.invoke('run', runtime.flowPath,
      '--input', JSON.stringify({ cancellationRequested: true }),
      '--local-agent', '--data-dir', runtime.data, '--json');
    expect(invoked.status, invoked.stderr + invoked.stdout).toBe(1);
    const report = JSON.parse(invoked.stdout);
    expect(report).toMatchObject({ ok: false, status: 'failed', completionReason: 'canceled' });
    expect(existsSync(runtime.calls)).toBe(false);
    await expectMarker(runtime.client, report.runId, 'canceled');
  });

  it.each([
    { reviewed: false, reason: 'step_failed', status: 'failed', exit: 1 },
    { reviewed: true, reason: 'needs_human', status: 'parked', exit: 3 },
  ])('reports $reason after reviewing work through the built CLI', async testCase => {
    const runtime = await fixture();
    writeFileSync(runtime.flowPath, `import { flow } from '@relayflows/surface';
type Input = { task: string; reviewed: boolean };
export default flow<Input>('software-factory',
  { budget: { wallclock: '1h' } }, async (f, input) => {
    await f.agent('implementer', { task: input.task });
    const clean = (await f.run(input.reviewed ? 'printf yes' : 'printf no')).trim() === 'yes';
    if (!clean) return f.done('step_failed');
    return f.done('needs_human');
  });
`);
    const input = { reviewed: testCase.reviewed, task: 'Implement the requested change.' };
    const invoked = runtime.invoke('run', runtime.flowPath, '--input', JSON.stringify(input),
      '--local-agent', '--data-dir', runtime.data, '--json');
    expect(invoked.status, invoked.stderr + invoked.stdout).toBe(testCase.exit);
    const report = JSON.parse(invoked.stdout);
    expect(report).toMatchObject({ ok: false, status: testCase.status });
    if (testCase.reason !== 'needs_human') expect(report.completionReason).toBe(testCase.reason);
    expect(existsSync(runtime.calls)).toBe(true);
    await expectMarker(runtime.client, report.runId, testCase.reason);
  });
});
