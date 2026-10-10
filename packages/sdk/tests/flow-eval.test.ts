import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateFlow, flowEvalSuiteSha256, flowEvalVersion, FlowEvalError, parseFlowEvalSuite,
  type FlowEvalExecutor, type FlowEvalRun, type FlowEvalSuite,
} from '../src/flow-eval.js';
import { cloudSpend, localRunOutcome, localRunSpend } from '../src/flow-eval-executors.js';
import type { CloudStep } from '../src/cloud-read.js';
import type { JournalEvent } from '../src/journal-client.js';
import { runCli } from '../src/cli.js';
import { parseEvalArgs, runEvalCli } from '../src/cli/eval.js';
import { writeJournalFixture } from './journal-fixture.js';

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function scratch(): string {
  const directory = mkdtempSync(join(tmpdir(), 'flow-eval-'));
  directories.push(directory);
  return directory;
}

/** A flow file on disk: the version under evaluation is its exact bytes. */
function flowFile(source = 'version: "1"\nsteps: []\n'): string {
  const path = join(scratch(), 'candidate.flow.yaml');
  writeFileSync(path, source);
  return path;
}

/** A clock each execution advances by the case's scripted latency. */
function scriptedClock() {
  let time = 1_000_000;
  return { now: () => time, advance: (ms: number) => { time += ms; } };
}

function scriptedExecutor(
  clock: ReturnType<typeof scriptedClock>,
  script: Record<string, Partial<FlowEvalRun> & { latencyMs?: number; throws?: string }>,
): { executor: FlowEvalExecutor; calls: Array<{ caseId: string; input: unknown }> } {
  const calls: Array<{ caseId: string; input: unknown }> = [];
  return {
    calls,
    executor: async ({ caseId, input }) => {
      calls.push({ caseId, input });
      const step = script[caseId] ?? {};
      clock.advance(step.latencyMs ?? 10);
      if (step.throws !== undefined) throw new Error(step.throws);
      const { latencyMs: _latency, throws: _throws, ...run } = step;
      return { runId: `run-${caseId}`, completionReason: 'success', costUsd: 0.01, ...run };
    },
  };
}

const SUITE: FlowEvalSuite = {
  name: 'triage-regressions',
  cases: [
    { id: 'happy', input: { ticket: 'AR-1' } },
    { id: 'declines-empty', input: {}, expect: { completionReason: 'declined' } },
    { id: 'names-ticket', input: { ticket: 'AR-2' }, expect: { detailIncludes: ['AR-2'] } },
  ],
};

describe('parseFlowEvalSuite', () => {
  it('accepts a well-formed suite and keeps inputs as frozen JSON', () => {
    const suite = parseFlowEvalSuite(JSON.parse(JSON.stringify({ ...SUITE, thresholds: { minPassRate: 0.5, maxTotalCostUsd: 1 } })));
    expect(suite.cases.map(c => c.id)).toEqual(['happy', 'declines-empty', 'names-ticket']);
    expect(suite.thresholds).toEqual({ minPassRate: 0.5, maxTotalCostUsd: 1 });
  });

  it.each([
    [[], 'Suite must be a JSON object.'],
    [{ name: 'x', cases: [] }, 'nonempty `cases`'],
    [{ name: '', cases: [{ id: 'a' }] }, 'nonempty `name`'],
    [{ name: 'x', cases: [{ id: 'a' }, { id: 'a' }] }, 'is not unique'],
    [{ name: 'x', cases: [{ id: 'has space' }] }, 'cases[0].id'],
    [{ name: 'x', cases: [{ id: 'a', expect: { maxCostUsd: -1 } }] }, 'non-negative'],
    [{ name: 'x', cases: [{ id: 'a', expect: { detailMatches: '(' } }] }, 'not a valid regular expression'],
    [{ name: 'x', cases: [{ id: 'a', expect: { typo: true } }] }, 'unknown field "typo"'],
    [{ name: 'x', cases: [{ id: 'a' }], thresholds: { minPassRate: 2 } }, 'from 0 to 1'],
    [{ name: 'x', cases: [{ id: 'a' }], extra: 1 }, 'unknown field "extra"'],
  ])('refuses %j', (value, message) => {
    expect(() => parseFlowEvalSuite(value)).toThrow(FlowEvalError);
    expect(() => parseFlowEvalSuite(value)).toThrow(message);
  });
});

describe('evaluateFlow', () => {
  it('re-executes every case and scores latency, cost and outcome', async () => {
    const clock = scriptedClock();
    const { executor, calls } = scriptedExecutor(clock, {
      happy: { latencyMs: 100, costUsd: 0.02, tokensIn: 10, tokensOut: 5 },
      'declines-empty': { latencyMs: 50, completionReason: 'declined', costUsd: 0 },
      'names-ticket': { latencyMs: 300, completionDetail: 'filed AR-2 to triage', costUsd: 0.03 },
    });
    const path = flowFile();
    const report = await evaluateFlow({ flow: { path }, suite: SUITE, executor, now: clock.now, executorName: 'scripted' });

    expect(calls).toEqual([
      { caseId: 'happy', input: { ticket: 'AR-1' } },
      { caseId: 'declines-empty', input: {} },
      { caseId: 'names-ticket', input: { ticket: 'AR-2' } },
    ]);
    expect(report).toMatchObject({
      schemaVersion: 1, kind: 'flows.eval.report', executor: 'scripted',
      flow: { path, version: await flowEvalVersion({ path }) },
      suite: { name: 'triage-regressions', sha256: flowEvalSuiteSha256(SUITE), cases: 3 },
      summary: { total: 3, passed: 3, failed: 0, errored: 0, passRate: 1, totalCostUsd: 0.05,
        latencyMs: { p50: 100, p95: 300, max: 300 } },
      gate: { pass: true, reasons: [], regressions: [] },
    });
    expect(report.cases[0]).toEqual({
      id: 'happy', outcome: 'pass', runId: 'run-happy', completionReason: 'success',
      latencyMs: 100, costUsd: 0.02, tokensIn: 10, tokensOut: 5, metrics: {}, failures: [],
    });
  });

  it('fails a case on any unmet expectation and fails the gate below the pass rate', async () => {
    const clock = scriptedClock();
    const { executor } = scriptedExecutor(clock, {
      happy: { completionReason: 'step_failed', completionDetail: 'agent exited 1' },
      'names-ticket': { completionDetail: 'filed something else' },
    });
    const report = await evaluateFlow({ flow: { path: flowFile() }, suite: SUITE, executor, now: clock.now });
    expect(report.cases.map(c => c.outcome)).toEqual(['fail', 'fail', 'fail']);
    expect(report.cases[0]!.failures).toEqual(['completionReason was step_failed; expected success (agent exited 1)']);
    expect(report.cases[1]!.failures).toEqual(['completionReason was success; expected declined']);
    expect(report.cases[2]!.failures).toEqual(['completion detail does not include "AR-2"']);
    expect(report.gate.pass).toBe(false);
    expect(report.gate.reasons).toEqual(['pass rate 0% is below 100% (0/3)']);
  });

  it('records an executor failure as error, and an error fails the gate even under a tolerant pass rate', async () => {
    const clock = scriptedClock();
    const { executor } = scriptedExecutor(clock, {
      happy: { throws: 'daemon unreachable' },
      'declines-empty': { completionReason: 'declined' },
      'names-ticket': { completionDetail: 'AR-2' },
    });
    const suite = { ...SUITE, thresholds: { minPassRate: 0.5 } };
    const report = await evaluateFlow({ flow: { path: flowFile() }, suite, executor, now: clock.now });
    expect(report.cases[0]).toMatchObject({ outcome: 'error', costUsd: null, failures: ['executor failed: daemon unreachable'] });
    expect(report.summary).toMatchObject({ passed: 2, errored: 1, totalCostUsd: null });
    expect(report.gate).toMatchObject({ pass: false, reasons: ['1 case(s) errored before a verdict'] });
  });

  it('enforces per-case and suite latency and cost ceilings; unknown cost never passes a cost ceiling', async () => {
    const clock = scriptedClock();
    const { executor } = scriptedExecutor(clock, {
      a: { latencyMs: 900, costUsd: 0.5 },
      b: { latencyMs: 10, costUsd: null },
    });
    const suite: FlowEvalSuite = {
      name: 'budgets',
      cases: [
        { id: 'a', expect: { maxLatencyMs: 500, maxCostUsd: 0.1 } },
        { id: 'b', expect: { maxCostUsd: 1 } },
      ],
      thresholds: { maxTotalCostUsd: 1, maxP95LatencyMs: 100, minPassRate: 0 },
    };
    const report = await evaluateFlow({ flow: { path: flowFile() }, suite, executor, now: clock.now });
    expect(report.cases[0]!.failures).toEqual(['latency 900ms exceeds 500ms', 'cost $0.5 exceeds $0.1']);
    expect(report.cases[1]!.failures).toEqual(['cost is unknown; the case caps it at $1']);
    expect(report.gate.reasons).toEqual([
      'total cost is unknown; the suite caps it at $1',
      'p95 latency 900ms exceeds 100ms',
    ]);
  });

  it('applies caller scorers as metrics and as pass/fail', async () => {
    const clock = scriptedClock();
    const { executor } = scriptedExecutor(clock, { happy: { metrics: { steps: 3 } } });
    const report = await evaluateFlow({
      flow: { path: flowFile() }, suite: { name: 's', cases: [{ id: 'happy' }] }, executor, now: clock.now,
      scorers: [
        { name: 'quality', score: () => ({ value: 0.4, pass: false, detail: 'below 0.7' }) },
        { name: 'length', score: async () => ({ value: 12 }) },
      ],
    });
    expect(report.cases[0]).toMatchObject({
      outcome: 'fail', metrics: { steps: 3, quality: 0.4, length: 12 }, failures: ['scorer quality failed: below 0.7'],
    });
  });

  it('fails the gate on a regression against a baseline report from the same suite', async () => {
    const clock = scriptedClock();
    const path = flowFile();
    const baseline = await evaluateFlow({ flow: { path }, suite: SUITE, now: clock.now,
      executor: scriptedExecutor(clock, { 'declines-empty': { completionReason: 'declined' }, 'names-ticket': { completionDetail: 'AR-2' } }).executor });
    expect(baseline.gate.pass).toBe(true);
    const tolerant = { ...SUITE, thresholds: { minPassRate: 0.5 } };
    const tolerantBaseline = { ...baseline, suite: { ...baseline.suite, sha256: flowEvalSuiteSha256(tolerant) } };
    const candidate = await evaluateFlow({ flow: { path }, suite: tolerant, now: clock.now, baseline: tolerantBaseline,
      executor: scriptedExecutor(clock, { 'declines-empty': { completionReason: 'declined' } }).executor });
    expect(candidate.summary.passRate).toBeCloseTo(2 / 3);
    expect(candidate.gate).toEqual({
      pass: false, regressions: ['names-ticket'],
      reasons: ['1 case(s) regressed against the baseline: names-ticket'],
    });
    await expect(evaluateFlow({ flow: { path }, suite: { name: 'other', cases: [{ id: 'x' }] }, baseline,
      executor: scriptedExecutor(clock, {}).executor })).rejects.toMatchObject({ code: 'suite_mismatch' });
  });

  it('refuses to judge any flow version or suite other than the pinned one', async () => {
    const clock = scriptedClock();
    const { executor, calls } = scriptedExecutor(clock, {});
    const path = flowFile();
    const version = await flowEvalVersion({ path });
    expect(version).toMatch(/^sha256:[0-9a-f]{64}$/u);
    writeFileSync(path, 'version: "1"\nsteps: []\n# edited\n');
    await expect(evaluateFlow({ flow: { path }, suite: SUITE, executor, expectVersion: version }))
      .rejects.toMatchObject({ code: 'version_mismatch' });
    await expect(evaluateFlow({ flow: { path }, suite: SUITE, executor, expectSuiteSha256: 'sha256:00' }))
      .rejects.toMatchObject({ code: 'suite_mismatch' });
    expect(calls).toEqual([]);
  });

  it('runs cases concurrently up to the limit and keeps report order', async () => {
    let active = 0;
    let peak = 0;
    const executor: FlowEvalExecutor = async ({ caseId }) => {
      active += 1; peak = Math.max(peak, active);
      await new Promise(resolve => setTimeout(resolve, caseId === 'a' ? 30 : 5));
      active -= 1;
      return { completionReason: 'success', costUsd: 0 };
    };
    const suite: FlowEvalSuite = { name: 'c', cases: ['a', 'b', 'c', 'd'].map(id => ({ id })) };
    const report = await evaluateFlow({ flow: { path: flowFile() }, suite, executor, concurrency: 2 });
    expect(peak).toBe(2);
    expect(report.cases.map(c => c.id)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('propagates an abort instead of recording it as a case verdict', async () => {
    const controller = new AbortController();
    const executor: FlowEvalExecutor = async () => {
      controller.abort(new Error('stop'));
      throw new Error('interrupted');
    };
    await expect(evaluateFlow({ flow: { path: flowFile() }, suite: SUITE, executor, signal: controller.signal }))
      .rejects.toThrow('stop');
  });
});

describe('executor mappings', () => {
  it('maps local run reports onto eval completion reasons', () => {
    const base = { command: 'run' as const, resolutions: [], diagnostics: [] };
    expect(localRunOutcome({ exitCode: 0, report: { ...base, ok: true, runId: 'r1', status: 'completed', completionReason: 'success' } }))
      .toEqual({ runId: 'r1', completionReason: 'success' });
    expect(localRunOutcome({ exitCode: 0, report: { ...base, ok: true, runId: 'r2', status: 'completed', completionReason: 'success',
      diagnostics: [{ severity: 'declined', kind: 'run_declined', message: 'Flow deliberately chose not to act.' }] } }))
      .toMatchObject({ completionReason: 'declined' });
    expect(localRunOutcome({ exitCode: 1, report: { ...base, ok: false, runId: 'r3', status: 'failed', completionReason: 'step_failed',
      completionDetail: 'checks failed' } })).toEqual({ runId: 'r3', completionReason: 'step_failed', completionDetail: 'checks failed' });
    expect(localRunOutcome({ exitCode: 3, report: { ...base, ok: false, runId: 'r4', status: 'parked' } }))
      .toMatchObject({ completionReason: 'needs_human' });
    expect(localRunOutcome({ exitCode: 2, report: { ...base, ok: false,
      diagnostics: [{ severity: 'refusal', kind: 'invalid_spec', message: 'bad spec' }] } as never }))
      .toEqual({ completionReason: 'refused', completionDetail: 'bad spec' });
  });

  it('sums hosted step spend and reports unknown when an agent step has no cost', () => {
    const step = (name: string, type: string, cost: number | null): CloudStep => ({
      step_name: name, step_type: type, status: 'completed', completion_reason: 'success', cli: null, model: null,
      sandbox_id: '', started_at: null, ended_at: null, duration_ms: 40, exit_code: 0, retry_count: 0,
      tokens_in: cost === null ? null : 100, tokens_out: cost === null ? null : 20, cost_usd: cost,
      output_summary: null, gate: null, attempts: [], transcript: null,
    });
    expect(cloudSpend([step('lint', 'deterministic', null), step('fix', 'agent', 0.25), step('review', 'llm', 0.05)]))
      .toMatchObject({ costUsd: 0.3, tokensIn: 200, tokensOut: 40, steps: [
        { id: 'lint', status: 'completed', durationMs: 40, costUsd: null },
        { id: 'fix', status: 'completed', durationMs: 40, costUsd: 0.25 },
        { id: 'review', status: 'completed', durationMs: 40, costUsd: 0.05 },
      ] });
    expect(cloudSpend([step('fix', 'agent', null)]).costUsd).toBeNull();
    expect(cloudSpend(undefined)).toEqual({ costUsd: null, tokensIn: null, tokensOut: null });
  });

  it('reads local spend from the root journal and the authored child runs it names', async () => {
    const dataDir = scratch();
    const event = (runId: string, seq: number, entry_type: string, step_id: string | null, payload: unknown, at_ms = seq * 100): JournalEvent =>
      ({ seq, segment_id: 1, entry_type, run_id: runId, step_id, attempt: step_id === null ? null : 1, at_ms, payload });
    const budget = (dollars: string, tokens: number) => ({ tokens_in: tokens, tokens_out: tokens / 2, dollars });
    writeJournalFixture(dataDir, 'child1', [
      event('child1', 1, 'step.attempt.started', 'worker', {}),
      event('child1', 2, 'step.completed', 'worker', { completionReason: 'success', budget: budget('0.120000', 100) }),
    ]).writer.close();
    writeJournalFixture(dataDir, 'root1', [
      event('root1', 1, 'step.attempt.started', 'root', {}),
      event('root1', 2, 'step.completed', 'root', { completionReason: 'success', budget: budget('0', 0),
        output: { journalSteps: [{ runId: 'child1' }, { runId: '../escape' }] } }),
      event('root1', 3, 'run.completed', null, { budget_total: budget('0', 0) }),
    ]).writer.close();
    expect(await localRunSpend('root1', dataDir)).toEqual({
      costUsd: 0.12, tokensIn: 100, tokensOut: 50,
      steps: [
        { id: 'root', status: 'success', durationMs: 100, costUsd: 0 },
        { id: 'worker', status: 'success', durationMs: 100, costUsd: 0.12 },
      ],
    });
    expect(await localRunSpend('missing', dataDir)).toEqual({ costUsd: null, tokensIn: null, tokensOut: null });
  });
});

describe('flows eval', () => {
  function io() {
    const stdout: string[] = [];
    const stderr: string[] = [];
    return { stdout, stderr, io: { stdout: (line: string) => stdout.push(line), stderr: (line: string) => stderr.push(line) } };
  }

  it('parses its flags and refuses local-only flags with --cloud', () => {
    expect(parseEvalArgs(['f.flow.ts', '--cases', 's.json'])).toEqual({
      command: 'eval', value: 'f.flow.ts', cases: 's.json', json: false, cloud: false, localAgent: false, dataDir: '.relayflowd',
    });
    expect(parseEvalArgs(['f.flow.ts'])).toBeUndefined();
    expect(parseEvalArgs(['f.flow.ts', '--cases', 's.json', '--cloud', '--local-agent'])).toBeUndefined();
    expect(parseEvalArgs(['f.flow.ts', '--cases', 's.json', '--concurrency', '0'])).toBeUndefined();
  });

  it('exits with the gate verdict and writes the report a deploy step consumes', async () => {
    const directory = scratch();
    const suitePath = join(directory, 'suite.json');
    const reportPath = join(directory, 'report.json');
    writeFileSync(suitePath, JSON.stringify(SUITE));
    const clock = scriptedClock();
    const passing = scriptedExecutor(clock, { 'declines-empty': { completionReason: 'declined' }, 'names-ticket': { completionDetail: 'AR-2' } });
    const args = parseEvalArgs([flowFile(), '--cases', suitePath, '--report', reportPath])!;
    const ok = io();
    expect(await runEvalCli(args, ok.io, new AbortController().signal, passing.executor)).toBe(0);
    expect(ok.stdout.at(-1)).toBe('GATE PASS');
    expect(JSON.parse(readFileSync(reportPath, 'utf8'))).toMatchObject({ kind: 'flows.eval.report', gate: { pass: true } });

    const failing = io();
    expect(await runEvalCli({ ...args, json: true, report: undefined }, failing.io, new AbortController().signal,
      scriptedExecutor(clock, {}).executor)).toBe(1);
    expect(JSON.parse(failing.stdout[0]!)).toMatchObject({ gate: { pass: false }, summary: { passed: 1, failed: 2 } });
  });

  it('refuses an unreadable suite with exit 2 through the real CLI dispatcher', async () => {
    const out = io();
    expect(await runCli(['eval', flowFile(), '--cases', join(scratch(), 'missing.json')], out.io)).toBe(2);
    expect(out.stderr.join('\n')).toContain('REFUSED [invalid_suite]');
  });
});
