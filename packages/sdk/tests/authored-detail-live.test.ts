// End to end against a real daemon: the flow says why, and every reader sees it.
//
// The mocked suites pin each seam; this one pins the path. A flow declares
// `done("step_failed", { detail })`, the durable runner journals it, and the
// same sentence comes back out of `flows run --json`, out of the journal the
// kernel wrote, and out of `flows status` — text and JSON — for a run whose
// every step succeeded.

import { writeFileSync } from 'node:fs';
import { afterEach, expect, it } from 'vitest';
import { chainFixture } from './flow-chain-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

/** The reviewer sentence cloud#3919 threw away, quotes and backtick included. */
const FINDING = 'One P2 remains: cleanup can report success while an ambiguous '
  + 'allocation stays invisible through all three sweeps — `review.clean` was not created.';

it('carries done("step_failed", { detail }) into the report, the journal and flows status', async () => {
  const runtime = chainFixture();
  cleanups.push(() => runtime.close());
  const client = await runtime.connect();
  writeFileSync(runtime.flowPath, `import { flow } from '@relayflows/surface';
export default flow('software-factory', async (f) => {
  await f.run('printf reviewed');
  f.done('step_failed', { detail: ${JSON.stringify(FINDING)} });
});
`);
  const flags = ['--data-dir', runtime.data, '--no-observer-link'];

  const run = runtime.invoke('run', runtime.flowPath, '--input', '{}', ...flags, '--json');
  expect(run.status, run.stderr + run.stdout).toBe(1);
  const report = JSON.parse(run.stdout);
  expect(report).toMatchObject({
    ok: false, status: 'failed', completionReason: 'step_failed', completedSteps: 2,
    completionDetail: FINDING,
  });
  const diagnostic = report.diagnostics.at(-1);
  expect(diagnostic.kind).toBe('step_failed');
  expect(diagnostic.detail).toBe(FINDING);
  expect(diagnostic.message).toBe(`Flow "software-factory" declared done("step_failed"): ${FINDING}`);
  expect(diagnostic.message).not.toContain('no step-level evidence to inspect');
  expect(run.stderr).toContain(`FAILED [step_failed] Flow "software-factory" declared done("step_failed"): ${FINDING}`);

  // The journal is the record: the root's output and the marker child's stdout.
  const root = await client.journalRead(report.runId, 1);
  const completed = root.entries.find((entry: any) => entry.entry_type === 'step.completed') as any;
  expect(completed.payload).toMatchObject({
    completionReason: 'success',
    output: { completionReason: 'step_failed', completionDetail: FINDING },
  });
  const children = completed.payload.output.journalSteps as Array<{ runId: string; completionReason: string }>;
  expect(children.map((child) => child.completionReason)).toEqual(['success', 'success']);
  const marker = await client.journalRead(children[1]!.runId, 1);
  const markerStdout = (marker.entries.find((entry: any) =>
    entry.entry_type === 'step.completed') as any).payload.output.stdout_tail as string;
  expect(JSON.parse(markerStdout)).toEqual({ completionReason: 'step_failed', detail: FINDING });

  // `flows status`, from the journal on disk alone.
  const status = runtime.invoke('status', report.runId, '--data-dir', runtime.data);
  expect(status.status, status.stderr + status.stdout).toBe(0);
  const lines = status.stdout.trim().split('\n');
  // The kernel's own account is unchanged: this run completed with success.
  expect(lines[0]).toContain('completed');
  expect(lines[0]).toContain('finished success');
  expect(lines[1]).toBe(`authored done("step_failed"): ${FINDING}`);

  const statusJson = runtime.invoke('status', report.runId, '--data-dir', runtime.data, '--json');
  expect(statusJson.status, statusJson.stderr + statusJson.stdout).toBe(0);
  const view = JSON.parse(statusJson.stdout);
  expect(view.authored_completion).toEqual({ reason: 'step_failed', detail: FINDING });
  expect(view.status).toBe('completed');
  expect(view.completion_reason).toBe('success');

  // Resuming a completed root returns the stored detail and repeats no effect.
  const resumed = runtime.invoke('resume', report.runId, ...flags, '--json');
  expect(resumed.status, resumed.stderr + resumed.stdout).toBe(1);
  expect(JSON.parse(resumed.stdout)).toMatchObject({
    command: 'resume', runId: report.runId, completionReason: 'step_failed', completionDetail: FINDING,
  });
  expect(await client.journalRead(report.runId, 1)).toEqual(root);
}, 60_000);

it('leaves a one-argument done("step_failed") reporting exactly as it always did', async () => {
  const runtime = chainFixture();
  cleanups.push(() => runtime.close());
  const client = await runtime.connect();
  writeFileSync(runtime.flowPath, `import { flow } from '@relayflows/surface';
export default flow('software-factory', async (f) => {
  f.done('step_failed');
});
`);
  const run = runtime.invoke('run', runtime.flowPath, '--input', '{}',
    '--data-dir', runtime.data, '--no-observer-link', '--json');
  expect(run.status, run.stderr + run.stdout).toBe(1);
  const report = JSON.parse(run.stdout);
  expect('completionDetail' in report).toBe(false);
  expect(report.diagnostics.at(-1).message).toBe(
    'Flow "software-factory" declared done("step_failed"): its own checks did not pass. '
    + 'No step failed, so there is no step-level evidence to inspect; the journal holds '
    + 'every step the flow ran before it decided.');
  expect('detail' in report.diagnostics.at(-1)).toBe(false);

  const completed = (await client.journalRead(report.runId, 1)).entries
    .find((entry: any) => entry.entry_type === 'step.completed') as any;
  expect('completionDetail' in completed.payload.output).toBe(false);
  const marker = await client.journalRead(
    completed.payload.output.journalSteps.at(-1).runId, 1);
  expect((marker.entries.find((entry: any) =>
    entry.entry_type === 'step.completed') as any).payload.output.stdout_tail)
    .toBe('{"completionReason":"step_failed"}');

  const status = runtime.invoke('status', report.runId, '--data-dir', runtime.data, '--json');
  expect('authored_completion' in JSON.parse(status.stdout)).toBe(false);
}, 60_000);
