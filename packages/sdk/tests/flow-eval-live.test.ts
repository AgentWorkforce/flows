// End to end against a real daemon: `evaluateFlow` RE-EXECUTES the candidate
// once per case (fresh runs, new run ids), and a flow step can run the same
// evaluation and branch on its verdict — the replay-as-gate a self-improving
// flow needs before it deploys.
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { evaluateFlow, type FlowEvalSuite } from '../src/flow-eval.js';
import { localFlowEvalExecutor } from '../src/flow-eval-executors.js';
import { chainFixture, shellWord } from './flow-chain-fixture.js';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });

const CANDIDATE = `import { flow } from '@relayflows/surface';
export default flow<{ n?: number }>('candidate', async (f, input) => {
  const n = input.n ?? 0;
  await f.run('printf ' + n);
  if (n > 1) return f.done('step_failed', { detail: 'n=' + n + ' is too large' });
  f.done('success');
});
`;

const SUITE: FlowEvalSuite = {
  name: 'candidate-regressions',
  cases: [
    { id: 'zero', input: {} },
    { id: 'one', input: { n: 1 } },
    { id: 'rejects-large', input: { n: 5 }, expect: { completionReason: 'step_failed', detailIncludes: ['n=5'] } },
  ],
};

it('re-executes a flow version once per case and reports a passing gate', async () => {
  const runtime = chainFixture();
  cleanups.push(() => runtime.close());
  await runtime.connect();
  const candidate = join(runtime.root, 'candidate.flow.ts');
  writeFileSync(candidate, CANDIDATE);

  const executor = localFlowEvalExecutor({ dataDir: runtime.data, daemon: { spawn: false }, cwd: runtime.root });
  const first = await evaluateFlow({ flow: { path: candidate }, suite: SUITE, executor, executorName: 'local' });
  expect(first.gate, JSON.stringify(first, null, 2)).toEqual({ pass: true, reasons: [], regressions: [] });
  expect(first.cases.map(c => [c.id, c.outcome, c.completionReason])).toEqual([
    ['zero', 'pass', 'success'], ['one', 'pass', 'success'], ['rejects-large', 'pass', 'step_failed'],
  ]);
  for (const result of first.cases) {
    expect(result.runId).toMatch(/\S/u);
    expect(result.latencyMs).toBeGreaterThan(0);
    expect(result.costUsd).toBe(0);
  }

  // Re-execution, not a journal read: a second evaluation makes new runs.
  const second = await evaluateFlow({ flow: { path: candidate }, suite: SUITE, executor, baseline: first });
  expect(second.gate.pass).toBe(true);
  const runIds = new Set([...first.cases, ...second.cases].map(c => c.runId));
  expect(runIds.size).toBe(6);

  // A regressed candidate fails the gate against the passing baseline.
  writeFileSync(candidate, CANDIDATE.replace('n > 1', 'n > 0'));
  const regressed = await evaluateFlow({ flow: { path: candidate }, suite: SUITE, executor, baseline: first });
  expect(regressed.flow.version).not.toBe(first.flow.version);
  expect(regressed.gate).toMatchObject({ pass: false, regressions: ['one'] });
}, 120_000);

it('lets a flow step run the evaluation and gate on its verdict', async () => {
  const runtime = chainFixture();
  cleanups.push(() => runtime.close());
  await runtime.connect();
  writeFileSync(join(runtime.root, 'candidate.flow.ts'), CANDIDATE);
  writeFileSync(join(runtime.root, 'suite.json'), JSON.stringify(SUITE));
  // The evaluation runs its cases on its own daemon, so the gate run's daemon
  // is never asked to host the runs it is waiting on.
  const evalData = join(runtime.root, 'eval-data');
  const command = [
    `RELAYFLOWD_BIN=${shellWord(runtime.binary)}`, shellWord(process.execPath), shellWord(resolve('dist/cli.js')),
    'eval', shellWord(join(runtime.root, 'candidate.flow.ts')), '--cases', shellWord(join(runtime.root, 'suite.json')),
    '--data-dir', shellWord(evalData), '--report', shellWord(join(runtime.root, 'report.json')),
  ].join(' ');
  writeFileSync(join(runtime.root, 'gate.flow.ts'), `import { flow } from '@relayflows/surface';
export default flow('deploy-gate', async (f) => {
  const verdict = await f.run(${JSON.stringify(command)}, { onNonZero: 'record' });
  if (!verdict.ok) return f.done('step_failed', { detail: 'eval gate failed: exit ' + verdict.exitCode + ': ' + verdict.output.slice(-600) });
  f.done('success', { detail: 'eval gate passed; deploy may proceed' });
});
`);
  const gate = runtime.invoke('run', join(runtime.root, 'gate.flow.ts'), '--input', '{}',
    '--data-dir', runtime.data, '--no-observer-link', '--json');
  expect(gate.status, gate.stderr + gate.stdout).toBe(0);
  expect(JSON.parse(gate.stdout)).toMatchObject({ ok: true, completionReason: 'success',
    completionDetail: 'eval gate passed; deploy may proceed' });
  const report = JSON.parse(readFileSync(join(runtime.root, 'report.json'), 'utf8'));
  expect(report).toMatchObject({ kind: 'flows.eval.report', executor: 'local', gate: { pass: true },
    summary: { total: 3, passed: 3 } });
  try {
    const { pid } = JSON.parse(readFileSync(join(evalData, 'connection.json'), 'utf8'));
    process.kill(pid, 'SIGTERM');
  } catch { /* the nested daemon already exited */ }
}, 120_000);
