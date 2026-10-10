// Re-run evaluation: execute one exact flow version against a frozen set of
// input cases and score the result, so a deploy can be gated on it.
//
// `flows replay` reads a finished run's journal and never executes anything.
// This module is the other thing: it RE-EXECUTES the flow, once per case,
// through an executor (local daemon, Cloud, or one the caller supplies), and
// returns a report whose `gate.pass` is the deploy decision.
//
// It is a library first. `evaluateFlow` is what a step calls — from a
// deterministic step's script or an authored body — and `flows eval` is a thin
// CLI over it whose exit code is the same verdict (0 pass, 1 fail, 2 refused).
//
// Two things are frozen and recorded in every report, so a verdict names
// exactly what it judged: the flow version (flow-eval-version.ts) and the suite
// (flow-eval-suite.ts). The version is re-checked before every case and after
// the last one; a change fails the gate rather than being scored as the
// original. Aggregation and the verdict itself live in flow-eval-gate.ts.

import { FlowEvalError } from './flow-eval-error.js';
import { decideFlowEvalGate, parseFlowEvalBaseline, summarizeFlowEval } from './flow-eval-gate.js';
import {
  FLOW_EVAL_REPORT_SCHEMA_VERSION,
  type FlowEvalCaseResult, type FlowEvalExecutor, type FlowEvalReport, type FlowEvalRun, type FlowEvalScorer,
} from './flow-eval-report.js';
import { flowEvalSuiteSha256, parseFlowEvalSuite, type FlowEvalCase, type FlowEvalSuite } from './flow-eval-suite.js';
import { flowEvalSources, flowEvalVersion, isPathTarget, type FlowEvalTarget } from './flow-eval-version.js';

export { FlowEvalError, type FlowEvalErrorCode } from './flow-eval-error.js';
export { parseFlowEvalBaseline, type FlowEvalBaseline } from './flow-eval-gate.js';
export * from './flow-eval-report.js';
export {
  MAX_FLOW_EVAL_CASES, flowEvalSuiteSha256, loadFlowEvalSuite, parseFlowEvalSuite,
  type FlowEvalCase, type FlowEvalExpectation, type FlowEvalSuite, type FlowEvalThresholds,
} from './flow-eval-suite.js';
export {
  MAX_FLOW_EVAL_SOURCES, flowEvalSources, flowEvalVersion,
  type FlowEvalTarget, type FlowEvalVersion,
} from './flow-eval-version.js';

export interface EvaluateFlowOptions {
  flow: FlowEvalTarget;
  suite: FlowEvalSuite;
  executor: FlowEvalExecutor;
  /** Recorded in the report; defaults to `custom`. */
  executorName?: string;
  scorers?: FlowEvalScorer[];
  /** Cases executed at once. Defaults to 1, which keeps runs from contending. */
  concurrency?: number;
  /** Refuse unless the flow version is exactly this (`sha256:<hex>`). */
  expectVersion?: string;
  /** Refuse unless the suite hashes to exactly this (`sha256:<hex>`). */
  expectSuiteSha256?: string;
  /**
   * A prior report on the same suite (parsed JSON is fine; it is validated
   * before any case runs). Any case that passed there and does not pass here
   * is a regression, and a regression fails the gate.
   */
  baseline?: unknown;
  signal?: AbortSignal;
  /** Clock injection for tests. */
  now?: () => number;
}

/**
 * Re-execute `flow` once per suite case and score the results.
 *
 * Never throws for a case that fails or errors: those are verdicts, recorded
 * in the report. Throws `FlowEvalError` only when the evaluation itself is
 * invalid (bad suite, baseline or options, or a pinned version/suite that does
 * not match), and rethrows an abort.
 */
export async function evaluateFlow(options: EvaluateFlowOptions): Promise<FlowEvalReport> {
  const now = options.now ?? Date.now;
  const suite = parseFlowEvalSuite(options.suite);
  const concurrency = options.concurrency ?? 1;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 64) {
    throw new FlowEvalError('invalid_options', 'concurrency must be an integer from 1 to 64.');
  }
  const names = new Set<string>();
  for (const scorer of options.scorers ?? []) {
    if (typeof scorer.name !== 'string' || scorer.name === '' || names.has(scorer.name)) {
      throw new FlowEvalError('invalid_options', 'Each scorer needs a unique, nonempty name.');
    }
    names.add(scorer.name);
  }
  const sources = await flowEvalSources(options.flow);
  const { version } = sources;
  if (options.expectVersion !== undefined && options.expectVersion !== version) {
    throw new FlowEvalError('version_mismatch', `Flow version is ${version}; expected ${options.expectVersion}.`);
  }
  const suiteSha256 = flowEvalSuiteSha256(suite);
  if (options.expectSuiteSha256 !== undefined && options.expectSuiteSha256 !== suiteSha256) {
    throw new FlowEvalError('suite_mismatch', `Suite hashes to ${suiteSha256}; expected ${options.expectSuiteSha256}.`);
  }
  const baseline = options.baseline === undefined ? undefined : parseFlowEvalBaseline(options.baseline);
  if (baseline !== undefined && baseline.suiteSha256 !== suiteSha256) {
    throw new FlowEvalError('suite_mismatch', 'The baseline report was produced from a different suite; regressions would not be comparable.');
  }

  const startedAt = now();
  const results: FlowEvalCaseResult[] = new Array(suite.cases.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      options.signal?.throwIfAborted();
      const index = next++;
      if (index >= suite.cases.length) return;
      results[index] = await runCase(suite.cases[index]!, options, now, version);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, suite.cases.length) }, worker));
  options.signal?.throwIfAborted();

  const summary = summarizeFlowEval(results);
  const gate = decideFlowEvalGate(suite, results, summary, baseline);
  // The last case may have run before an edit the per-case check could not see.
  const after = await flowEvalVersion(options.flow).catch(() => 'unreadable');
  if (after !== version) {
    gate.pass = false;
    gate.reasons.push(`flow source changed during the evaluation (${version} is now ${after}); the results judge no single version`);
  }
  return {
    schemaVersion: FLOW_EVAL_REPORT_SCHEMA_VERSION,
    kind: 'flows.eval.report',
    flow: { ...(isPathTarget(options.flow) ? { path: options.flow.path } : {}), version, files: sources.files },
    suite: { name: suite.name, sha256: suiteSha256, cases: suite.cases.length },
    executor: options.executorName ?? 'custom',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    cases: results,
    summary,
    gate,
  };
}

async function runCase(
  testCase: FlowEvalCase, options: EvaluateFlowOptions, now: () => number, version: string,
): Promise<FlowEvalCaseResult> {
  const started = now();
  // Every case re-proves it runs the judged version. An executor reads the
  // flow from disk, so an edit mid-evaluation would otherwise be scored under
  // the version recorded before it.
  const current = await flowEvalVersion(options.flow).catch(() => 'unreadable');
  if (current !== version) {
    return {
      id: testCase.id, outcome: 'error', latencyMs: 0, costUsd: null, tokensIn: null, tokensOut: null, metrics: {},
      failures: [`flow source changed during the evaluation (${version} is now ${current}); this case was not run`],
    };
  }
  let run: FlowEvalRun;
  try {
    run = await options.executor({
      flow: options.flow, caseId: testCase.id,
      ...(testCase.input === undefined ? {} : { input: testCase.input }),
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    });
  } catch (error) {
    // An abort is the caller stopping the evaluation, not this case's verdict.
    if (options.signal?.aborted) throw options.signal.reason ?? error;
    return {
      id: testCase.id, outcome: 'error', latencyMs: Math.max(0, now() - started),
      costUsd: null, tokensIn: null, tokensOut: null, metrics: {},
      failures: [`executor failed: ${error instanceof Error ? error.message : String(error)}`],
    };
  }
  const latencyMs = Math.max(0, now() - started);
  const costUsd = finiteOrNull(run.costUsd);
  const failures: string[] = [];
  const expect = testCase.expect ?? {};
  const wantReason = expect.completionReason ?? 'success';
  if (run.completionReason !== wantReason) {
    failures.push(`completionReason was ${run.completionReason}; expected ${wantReason}`
      + (run.completionDetail ? ` (${truncate(run.completionDetail)})` : ''));
  }
  const detail = run.completionDetail ?? '';
  for (const fragment of expect.detailIncludes ?? []) {
    if (!detail.includes(fragment)) failures.push(`completion detail does not include ${JSON.stringify(fragment)}`);
  }
  if (expect.detailMatches !== undefined && !new RegExp(expect.detailMatches, 'u').test(detail)) {
    failures.push(`completion detail does not match /${expect.detailMatches}/`);
  }
  if (expect.maxLatencyMs !== undefined && latencyMs > expect.maxLatencyMs) {
    failures.push(`latency ${latencyMs}ms exceeds ${expect.maxLatencyMs}ms`);
  }
  if (expect.maxCostUsd !== undefined) {
    if (costUsd === null) failures.push(`cost is unknown; the case caps it at $${expect.maxCostUsd}`);
    else if (costUsd > expect.maxCostUsd) failures.push(`cost $${costUsd} exceeds $${expect.maxCostUsd}`);
  }
  const metrics: Record<string, number> = {};
  for (const [name, value] of Object.entries(run.metrics ?? {})) {
    if (Number.isFinite(value)) metrics[name] = value;
  }
  let errored = false;
  for (const scorer of options.scorers ?? []) {
    try {
      const score = await scorer.score(run, testCase);
      if (score.value !== undefined && Number.isFinite(score.value)) metrics[scorer.name] = score.value;
      if (score.pass === false) failures.push(`scorer ${scorer.name} failed` + (score.detail ? `: ${score.detail}` : ''));
    } catch (error) {
      errored = true;
      failures.push(`scorer ${scorer.name} threw: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return {
    id: testCase.id,
    outcome: errored ? 'error' : failures.length === 0 ? 'pass' : 'fail',
    ...(run.runId === undefined ? {} : { runId: run.runId }),
    completionReason: run.completionReason,
    latencyMs,
    costUsd,
    tokensIn: finiteOrNull(run.tokensIn),
    tokensOut: finiteOrNull(run.tokensOut),
    metrics,
    ...(run.steps === undefined ? {} : { steps: run.steps }),
    failures,
  };
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function truncate(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}
