import { existsSync, writeFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { chainFixture } from './flow-chain-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

it('runs an input guard and resumes its completed declined root without repeated effects', async () => {
  const runtime = chainFixture();
  cleanups.push(() => runtime.close());
  const client = await runtime.connect();
  writeFileSync(runtime.flowPath, `import { flow } from '@relayflows/surface';
export default flow<{ticket?: string}>('guard', async (f, input) => {
  await f.run('printf inspected');
  if (!input.ticket) return f.done('declined');
  await f.agent('worker', { task: input.ticket });
  f.done('success');
});
`);
  const flags = ['--data-dir', runtime.data, '--no-observer-link'];
  const first = runtime.invoke('run', runtime.flowPath, '--input', '{}', ...flags, '--json');
  expect(first.status, first.stderr + first.stdout).toBe(0);
  expect(first.stderr).toContain('DECLINED [run_declined]');
  const report = JSON.parse(first.stdout);
  expect(report).toMatchObject({ ok: true, status: 'completed', completionReason: 'success', completedSteps: 2,
    diagnostics: [{ severity: 'declined', kind: 'run_declined' }] });
  expect(existsSync(runtime.calls)).toBe(false);
  const root = await client.journalRead(report.runId, 1);
  const completed = root.entries.find((e: any) => e.entry_type === 'step.completed') as any;
  expect(completed.payload).toMatchObject({ completionReason: 'success', output: { completionReason: 'declined' } });
  const children = completed.payload.output.journalSteps as Array<{ runId: string; completionReason: string }>;
  expect(children.map(child => child.completionReason)).toEqual(['success', 'success']);
  const before = await Promise.all(children.map(child => client.journalRead(child.runId, 1)));
  expect(before[0]!.entries).toContainEqual(expect.objectContaining({
    entry_type: 'step.completed', payload: expect.objectContaining({
      output: expect.objectContaining({ stdout_tail: 'inspected' }),
    }),
  }));
  expect(before[1]!.entries).toContainEqual(expect.objectContaining({
    entry_type: 'step.completed', payload: expect.objectContaining({
      completionReason: 'success', output: expect.objectContaining({ stdout_tail: '{"completionReason":"declined"}', exit_code: 0 }),
    }),
  }));
  const resumed = runtime.invoke('resume', report.runId, ...flags, '--json');
  expect(resumed.status, resumed.stderr + resumed.stdout).toBe(0);
  expect(JSON.parse(resumed.stdout)).toMatchObject({
    command: 'resume', runId: report.runId, completedSteps: 2,
    ok: true, status: 'completed', completionReason: 'success', diagnostics: report.diagnostics,
  });
  const plain = runtime.invoke('resume', report.runId, ...flags);
  expect(plain.status, plain.stderr + plain.stdout).toBe(0);
  expect(plain.stderr).toContain('DECLINED [run_declined]');
  expect(await client.journalRead(report.runId, 1)).toEqual(root);
  expect(await Promise.all(children.map(child => client.journalRead(child.runId, 1)))).toEqual(before);
}, 60_000);
