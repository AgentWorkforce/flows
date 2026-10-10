import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateFlow, flowEvalSuiteSha256, flowEvalVersion, FlowEvalError, parseFlowEvalSuite,
  type FlowEvalExecutor, type FlowEvalRun, type FlowEvalSuite,
} from '../src/flow-eval.js';
import { localRunOutcome, localRunSpend } from '../src/flow-eval-local.js';
import { cloudFlowEvalExecutor, cloudRunOutcome, cloudSpend } from '../src/flow-eval-cloud.js';
import { flowEvalSources, localSpecifiers } from '../src/flow-eval-version.js';
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
  it('accepts a well-formed suite and returns it deeply frozen', () => {
    const suite = parseFlowEvalSuite(JSON.parse(JSON.stringify({ ...SUITE, thresholds: { minPassRate: 0.5, maxTotalCostUsd: 1 } })));
    expect(suite.cases.map(c => c.id)).toEqual(['happy', 'declines-empty', 'names-ticket']);
    expect(suite.thresholds).toEqual({ minPassRate: 0.5, maxTotalCostUsd: 1 });
    for (const value of [suite, suite.cases, suite.cases[0], suite.cases[0]!.input, suite.cases[2]!.expect, suite.thresholds]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
  });

  it('refuses a case input larger than flows run accepts', () => {
    expect(() => parseFlowEvalSuite({ name: 'x', cases: [{ id: 'a', input: { blob: 'x'.repeat(1_048_577) } }] }))
      .toThrow('cases[0].input is not JSON data');
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

  it('judges the cost ceiling on the exact sum, not the rounded summary figure', async () => {
    const executor: FlowEvalExecutor = async ({ caseId }) => ({ completionReason: 'success', costUsd: caseId === 'a' ? 0.5 : 0.5000004 });
    const report = await evaluateFlow({ flow: { path: flowFile() }, executor,
      suite: { name: 's', cases: [{ id: 'a' }, { id: 'b' }], thresholds: { maxTotalCostUsd: 1.0000001 } } });
    expect(report.summary.totalCostUsd).toBe(1);
    expect(report.gate.pass).toBe(false);
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

describe('flow version', () => {
  function authoredProject() {
    const root = scratch();
    writeFileSync(join(root, 'flows.json'), '{}');
    mkdirSync(join(root, 'lib'));
    writeFileSync(join(root, 'lib', 'prompt.ts'), "export const PROMPT = 'triage';\n");
    writeFileSync(join(root, 'child.flow.ts'), "export default 1;\n");
    const entry = join(root, 'main.flow.ts');
    writeFileSync(entry, [
      "import { flow } from '@relayflows/surface';",
      "import { PROMPT } from './lib/prompt.js';",
      "export default flow({ name: 'main', use: ['./child.flow.ts'] }, async (f) => { await f.run(PROMPT); });",
    ].join('\n'));
    return { root, entry };
  }

  it('covers relative imports, used flows and the project config, not just the entry', async () => {
    const { root, entry } = authoredProject();
    const before = await flowEvalSources({ path: entry });
    expect(before.files).toEqual(['child.flow.ts', 'flows.json', 'lib/prompt.ts', 'main.flow.ts']);
    // A stale compiled sibling is covered too, whichever one a loader picks.
    writeFileSync(join(root, 'lib', 'prompt.js'), "export const PROMPT = 'stale';\n");
    expect((await flowEvalSources({ path: entry })).files).toContain('lib/prompt.js');
    writeFileSync(join(root, 'lib', 'prompt.ts'), "export const PROMPT = 'something else';\n");
    const afterHelper = await flowEvalVersion({ path: entry });
    expect(afterHelper).not.toBe(before.version);
    writeFileSync(join(root, 'child.flow.ts'), "export default 2;\n");
    expect(await flowEvalVersion({ path: entry })).not.toBe(afterHelper);
  });

  it('includes the package.json that governs each imported file, including nested scopes', async () => {
    const root = scratch();
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    mkdirSync(join(root, 'legacy'));
    writeFileSync(join(root, 'legacy', 'package.json'), '{"type":"commonjs"}');
    writeFileSync(join(root, 'legacy', 'rules.js'), 'module.exports = 1;\n');
    const entry = join(root, 'main.flow.ts');
    writeFileSync(entry, "import rules from './legacy/rules.js';\nexport default rules;\n");
    expect((await flowEvalSources({ path: entry })).files).toEqual(['legacy/package.json', 'legacy/rules.js', 'main.flow.ts', 'package.json']);
  });

  it('pins a package lockfile found beside package.json without a flows.json', async () => {
    const root = scratch();
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3}');
    mkdirSync(join(root, 'flows'));
    const entry = join(root, 'flows', 'standalone.flow.ts');
    writeFileSync(entry, "export default 1;\n");
    const before = await flowEvalSources({ path: entry });
    expect(before.files).toEqual(['../package-lock.json', '../package.json', 'standalone.flow.ts']);
    writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion":3,"packages":{}}');
    expect(await flowEvalVersion({ path: entry })).not.toBe(before.version);
  });

  it('finds import, re-export, dynamic import and use-path specifiers lexically', () => {
    expect(localSpecifiers([
      "import { a } from './a.js';", "import type { B } from '../b';", "export * from './c.ts';",
      "import './side-effect.js';", "const d = await import('./d.js');", "use: ['./e.flow.ts']",
      "import { x } from 'some-package';",
    ].join('\n')).sort()).toEqual(['../b', './a.js', './c.ts', './d.js', './e.flow.ts', './side-effect.js']);
  });

  it('gives every case its own read-only copy, so neither the working tree nor an earlier case changes what runs', async () => {
    const { root, entry } = authoredProject();
    const version = await flowEvalVersion({ path: entry });
    const seen: string[] = [];
    const copies = new Set<string>();
    const executor: FlowEvalExecutor = async ({ flow }) => {
      const sealed = (flow as { path: string }).path;
      expect(sealed).not.toBe(entry);
      copies.add(sealed);
      const helper = join(sealed, '..', 'lib', 'prompt.ts');
      seen.push(readFileSync(helper, 'utf8'));
      // Neither the file nor its directory is writable inside a copy (root ignores modes).
      if (process.getuid?.() !== 0) {
        expect(() => writeFileSync(sealed, 'tampered')).toThrow();
        expect(() => rmSync(helper)).toThrow();
      }
      // Edit the working tree mid-evaluation; the next case must not see it.
      writeFileSync(join(root, 'lib', 'prompt.ts'), "export const PROMPT = 'edited';\n");
      return { completionReason: 'success', costUsd: 0 };
    };
    const report = await evaluateFlow({ flow: { path: entry }, executor,
      suite: { name: 's', cases: [{ id: 'one' }, { id: 'two' }] } });
    expect(seen).toEqual(["export const PROMPT = 'triage';\n", "export const PROMPT = 'triage';\n"]);
    expect(copies.size).toBe(2);
    for (const copy of copies) expect(() => readFileSync(copy)).toThrow();
    expect(report.flow.version).toBe(version);
    expect(report.gate.pass).toBe(true);
  });

  it('executes a frozen clone of an in-memory spec, never the caller\'s object', async () => {
    const spec = { version: '0.1.0', name: 'inline', steps: [{ id: 'a', type: 'deterministic', command: 'true' }] } as never;
    const received: unknown[] = [];
    const report = await evaluateFlow({ flow: spec, suite: { name: 's', cases: [{ id: 'one' }, { id: 'two' }] },
      executor: async ({ flow }) => { received.push(flow); return { completionReason: 'success' }; } });
    expect(received[0]).not.toBe(spec);
    expect(received[0]).toBe(received[1]);
    expect(Object.isFrozen(received[0])).toBe(true);
    expect(report.flow.version).toBe(await flowEvalVersion(spec));
  });

  it('hashes and seals the payloads of locked flow extensions', async () => {
    const { root, entry } = authoredProject();
    const digest = 'a'.repeat(64);
    writeFileSync(join(root, 'flows.lock.json'), JSON.stringify({ version: 2, plugins: [{
      name: 'triage-ext', kind: 'flow-extension', version: '1.0.0', digest, manifestSha256: 'b'.repeat(64), order: 1,
      resolvedAt: '2026-10-01T00:00:00.000Z',
      source: { host: 'github', owner: 'AgentWorkforce', repo: 'ext', sha: 'c'.repeat(40), path: 'triage' },
    }] }));
    await expect(flowEvalSources({ path: entry })).rejects.toMatchObject({ code: 'unreadable_flow' });
    const store = join(root, '.flows', 'plugins', `triage-ext@sha256:${digest}`);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'extension.mjs'), 'export default 1;\n');
    const before = await flowEvalSources({ path: entry });
    expect(before.files).toContain(`.flows/plugins/triage-ext@sha256:${digest}/extension.mjs`);
    writeFileSync(join(store, 'extension.mjs'), 'export default 2;\n');
    expect(await flowEvalVersion({ path: entry })).not.toBe(before.version);
  });

  it('treats a negative reported cost as unknown, so it fails cost ceilings instead of offsetting', async () => {
    const executor: FlowEvalExecutor = async ({ caseId }) => ({ completionReason: 'success', costUsd: caseId === 'a' ? 5 : -5 });
    const report = await evaluateFlow({ flow: { path: flowFile() }, executor,
      suite: { name: 's', cases: [{ id: 'a' }, { id: 'b' }], thresholds: { maxTotalCostUsd: 1 } } });
    expect(report.cases[1]!.costUsd).toBeNull();
    expect(report.summary.totalCostUsd).toBeNull();
    expect(report.gate.pass).toBe(false);
  });

  it('refuses a baseline that does not cover exactly the suite cases', async () => {
    const clock = scriptedClock();
    const path = flowFile();
    const baseline = await evaluateFlow({ flow: { path }, suite: SUITE, now: clock.now, executor: scriptedExecutor(clock, {}).executor });
    const truncated = { ...baseline, cases: baseline.cases.filter(c => c.id !== 'names-ticket') };
    await expect(evaluateFlow({ flow: { path }, suite: SUITE, baseline: truncated, executor: scriptedExecutor(clock, {}).executor }))
      .rejects.toMatchObject({ code: 'invalid_baseline', message: expect.stringContaining('missing names-ticket') });
  });

  it('refuses a Cloud evaluation of a flow that imports local modules, before submitting', async () => {
    const { entry } = authoredProject();
    const report = await evaluateFlow({ flow: { path: entry }, executor: cloudFlowEvalExecutor({ apiUrl: 'http://127.0.0.1:9' }),
      suite: { name: 's', cases: [{ id: 'one' }] } });
    expect(report.cases[0]).toMatchObject({ outcome: 'error' });
    expect(report.cases[0]!.failures[0]).toContain('imports local modules (child.flow.ts, lib/prompt.ts)');
  });

  it('counts an imported JSON file as a local import for Cloud, but not project metadata', async () => {
    const root = scratch();
    writeFileSync(join(root, 'package.json'), '{"type":"module"}');
    writeFileSync(join(root, 'rules.json'), '{"max":1}');
    const entry = join(root, 'main.flow.ts');
    writeFileSync(entry, "import rules from './rules.json' with { type: 'json' };\nexport default rules;\n");
    const report = await evaluateFlow({ flow: { path: entry }, executor: cloudFlowEvalExecutor({ apiUrl: 'http://127.0.0.1:9' }),
      suite: { name: 's', cases: [{ id: 'one' }] } });
    expect(report.cases[0]!.failures[0]).toContain('imports local modules (rules.json)');
  });

  it('does not count sealed extension payloads as local imports for Cloud', async () => {
    const root = scratch();
    writeFileSync(join(root, 'flows.json'), '{}');
    const digest = 'a'.repeat(64);
    writeFileSync(join(root, 'flows.lock.json'), JSON.stringify({ version: 2, plugins: [{
      name: 'triage-ext', kind: 'flow-extension', version: '1.0.0', digest, manifestSha256: 'b'.repeat(64), order: 1,
      resolvedAt: '2026-10-01T00:00:00.000Z',
      source: { host: 'github', owner: 'AgentWorkforce', repo: 'ext', sha: 'c'.repeat(40), path: 'triage' },
    }] }));
    const store = join(root, '.flows', 'plugins', `triage-ext@sha256:${digest}`);
    mkdirSync(store, { recursive: true });
    writeFileSync(join(store, 'extension.mjs'), 'export default 1;\n');
    const entry = join(root, 'standalone.flow.ts');
    writeFileSync(entry, "export default 1;\n");
    const report = await evaluateFlow({ flow: { path: entry }, executor: cloudFlowEvalExecutor({ apiUrl: 'http://127.0.0.1:9' }),
      suite: { name: 's', cases: [{ id: 'one' }] } });
    // Gets past the local-import refusal and fails later, at the (unreachable) Cloud request.
    expect(report.cases[0]!.failures[0]).not.toContain('imports local modules');
  });

  it('refuses a malformed baseline before running any case', async () => {
    const calls: string[] = [];
    const executor: FlowEvalExecutor = async ({ caseId }) => { calls.push(caseId); return { completionReason: 'success' }; };
    const baseline = { kind: 'flows.eval.report', suite: { sha256: flowEvalSuiteSha256(SUITE) }, cases: [null] };
    await expect(evaluateFlow({ flow: { path: flowFile() }, suite: SUITE, executor, baseline }))
      .rejects.toMatchObject({ code: 'invalid_baseline' });
    expect(calls).toEqual([]);
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
    expect(localRunOutcome({ exitCode: 3, report: { ...base, ok: false, runId: 'r5', status: 'parked', parkCause: 'worker_unavailable' } }))
      .toMatchObject({ completionReason: 'worker_unavailable' });
    // A failed authored run names its failing child as runId; spend is read from the root.
    expect(localRunOutcome({ exitCode: 1, report: { ...base, ok: false, runId: 'child-3', rootRunId: 'root-1', status: 'failed',
      completionReason: 'step_failed' } })).toMatchObject({ runId: 'root-1', completionReason: 'step_failed' });
    expect(localRunOutcome({ exitCode: 2, report: { ...base, ok: false,
      diagnostics: [{ severity: 'refusal', kind: 'invalid_spec', message: 'bad spec' }] } as never }))
      .toEqual({ completionReason: 'refused', completionDetail: 'bad spec' });
  });

  it('maps a hosted run report to the same verdict and detail as a local one', () => {
    const record = (status: string, result: Record<string, unknown>) => ({ runId: 'run-1', relayflowVersion: 'v2', status, result });
    expect(cloudRunOutcome(record('completed', { ok: true, status: 'completed', completionReason: 'success',
      diagnostics: [{ severity: 'declined', kind: 'run_declined', message: 'Flow deliberately chose not to act.' }] }), 'run-1'))
      .toEqual({ completionReason: 'declined' });
    expect(cloudRunOutcome(record('completed', { ok: true, status: 'completed', completionReason: 'success',
      completionDetail: 'filed AR-2', diagnostics: [] }), 'run-1')).toEqual({ completionReason: 'success', completionDetail: 'filed AR-2' });
    expect(cloudRunOutcome(record('failed', { ok: false, status: 'failed', completionReason: 'step_failed',
      completionDetail: 'n=5 is too large', diagnostics: [] }), 'run-1')).toEqual({ completionReason: 'step_failed', completionDetail: 'n=5 is too large' });
    expect(cloudRunOutcome(record('failed', { ok: false, status: 'parked', parkCause: 'worker_unavailable',
      completionReason: 'needs_human', humanWait: undefined, diagnostics: [] }), 'run-1')).toMatchObject({ completionReason: 'worker_unavailable' });
    expect(() => cloudRunOutcome({ runId: 'other' }, 'run-1')).toThrow();
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

  it('sums per-step spend across the root and every authored child, never cumulative run totals', async () => {
    const dataDir = scratch();
    const event = (runId: string, seq: number, entry_type: string, step_id: string | null, payload: unknown, at_ms = seq * 100): JournalEvent =>
      ({ seq, segment_id: 1, entry_type, run_id: runId, step_id, attempt: step_id === null ? null : 1, at_ms, payload });
    const budget = (dollars: string, tokens: number) => ({ tokens_in: tokens, tokens_out: tokens / 2, dollars });
    const indexed = (runId: string) => ({ stream: 'authored-steps', message: {
      index: 'relayflows.authored-step.v1', step: runId, runId, state: 'admitted' } });
    // Child 2 started from child 1's prior spend: its run total ($0.30) includes child 1's $0.10.
    writeJournalFixture(dataDir, 'child1', [
      event('child1', 1, 'step.attempt.started', 'one', {}),
      event('child1', 2, 'step.completed', 'one', { completionReason: 'success', budget: budget('0.100000', 100) }),
      event('child1', 3, 'run.completed', null, { budget_total: budget('0.100000', 100) }),
    ]).writer.close();
    writeJournalFixture(dataDir, 'child2', [
      event('child2', 1, 'step.attempt.started', 'two', {}),
      event('child2', 2, 'step.completed', 'two', { completionReason: 'step_failed', budget: budget('0.200000', 200) }),
      event('child2', 3, 'run.completed', null, { budget_total: budget('0.300000', 300) }),
    ]).writer.close();
    // A failed root: its completion output names no child, but its index stream does.
    writeJournalFixture(dataDir, 'root1', [
      event('root1', 1, 'step.attempt.started', 'root', {}),
      event('root1', 2, 'stream.appended', null, indexed('child1')),
      event('root1', 3, 'stream.appended', null, indexed('child2')),
      event('root1', 4, 'stream.appended', null, { stream: 'authored-steps', message: { index: 'relayflows.authored-step.v1', runId: '../escape' } }),
      event('root1', 5, 'step.completed', 'root', { completionReason: 'worker_error', output: { error: 'body failed' } }),
      event('root1', 6, 'run.completed', null, { budget_total: budget('0', 0) }),
    ]).writer.close();
    expect(await localRunSpend('root1', dataDir)).toEqual({
      costUsd: 0.3, tokensIn: 300, tokensOut: 150,
      steps: [
        { id: 'root', status: 'worker_error', durationMs: 400 },
        { id: 'one', status: 'success', durationMs: 100, costUsd: 0.1 },
        { id: 'two', status: 'step_failed', durationMs: 100, costUsd: 0.2 },
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

  it('reports a refusal as JSON under --json, including a report it could not write', async () => {
    const directory = scratch();
    const suitePath = join(directory, 'suite.json');
    writeFileSync(suitePath, JSON.stringify({ name: 's', cases: [{ id: 'a' }] }));
    const out = io();
    const args = parseEvalArgs([flowFile(), '--cases', suitePath, '--json', '--report', join(directory, 'missing-dir', 'r.json')])!;
    expect(await runEvalCli(args, out.io, new AbortController().signal, async () => ({ completionReason: 'success' }))).toBe(2);
    expect(JSON.parse(out.stdout.at(-1)!)).toMatchObject({ ok: false, diagnostics: [{ severity: 'refusal', kind: 'report_unwritable' }] });
  });

  it('refuses an unreadable suite with exit 2 through the real CLI dispatcher', async () => {
    const out = io();
    expect(await runCli(['eval', flowFile(), '--cases', join(scratch(), 'missing.json')], out.io)).toBe(2);
    expect(out.stderr.join('\n')).toContain('REFUSED [invalid_suite]');
  });
});
