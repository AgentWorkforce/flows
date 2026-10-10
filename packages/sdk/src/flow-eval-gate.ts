// The verdict of a flow evaluation: case results aggregated into a summary,
// and the summary judged against the suite's thresholds and a baseline.

import { FlowEvalError } from './flow-eval-error.js';
import type { FlowEvalCaseResult, FlowEvalOutcome, FlowEvalReport } from './flow-eval-report.js';
import { isRecord, type FlowEvalSuite } from './flow-eval-suite.js';

/** The part of a prior report a regression check reads, validated. */
export interface FlowEvalBaseline {
  suiteSha256: string;
  outcomes: ReadonlyMap<string, FlowEvalOutcome>;
}

const OUTCOMES: readonly string[] = ['pass', 'fail', 'error'];

/**
 * Validate an untrusted prior report (parsed JSON) before any case runs, so a
 * malformed baseline is refused before an evaluation spends anything.
 */
export function parseFlowEvalBaseline(value: unknown): FlowEvalBaseline {
  const fail = (message: string): never => { throw new FlowEvalError('invalid_baseline', message); };
  if (!isRecord(value) || value['kind'] !== 'flows.eval.report') fail('Baseline is not a flows eval report.');
  const report = value as Record<string, unknown>;
  const suite = report['suite'];
  if (!isRecord(suite) || typeof suite['sha256'] !== 'string') fail('Baseline report names no suite sha256.');
  if (!Array.isArray(report['cases'])) fail('Baseline report has no `cases` array.');
  const outcomes = new Map<string, FlowEvalOutcome>();
  for (const [index, entry] of (report['cases'] as unknown[]).entries()) {
    if (!isRecord(entry) || typeof entry['id'] !== 'string' || !OUTCOMES.includes(entry['outcome'] as string)) {
      fail(`Baseline cases[${index}] needs a string \`id\` and an \`outcome\` of pass, fail or error.`);
    }
    const item = entry as Record<string, unknown>;
    if (outcomes.has(item['id'] as string)) fail(`Baseline case id "${item['id']}" is not unique.`);
    outcomes.set(item['id'] as string, item['outcome'] as FlowEvalOutcome);
  }
  return { suiteSha256: (suite as Record<string, unknown>)['sha256'] as string, outcomes };
}

export function summarizeFlowEval(results: readonly FlowEvalCaseResult[]): FlowEvalReport['summary'] {
  const passed = results.filter(r => r.outcome === 'pass').length;
  const failed = results.filter(r => r.outcome === 'fail').length;
  const errored = results.filter(r => r.outcome === 'error').length;
  const costs = results.map(r => r.costUsd);
  const latencies = results.map(r => r.latencyMs).sort((a, b) => a - b);
  return {
    total: results.length, passed, failed, errored,
    passRate: results.length === 0 ? 0 : passed / results.length,
    totalCostUsd: costs.some(c => c === null) ? null : roundUsd(costs.reduce<number>((sum, c) => sum + c!, 0)),
    latencyMs: { p50: percentile(latencies, 0.5), p95: percentile(latencies, 0.95), max: latencies.at(-1) ?? 0 },
  };
}

export function decideFlowEvalGate(
  suite: FlowEvalSuite,
  results: readonly FlowEvalCaseResult[],
  summary: FlowEvalReport['summary'],
  baseline: FlowEvalBaseline | undefined,
): FlowEvalReport['gate'] {
  const reasons: string[] = [];
  const thresholds = suite.thresholds ?? {};
  const minPassRate = thresholds.minPassRate ?? 1;
  if (summary.passRate < minPassRate) {
    reasons.push(`pass rate ${formatRate(summary.passRate)} is below ${formatRate(minPassRate)} (${summary.passed}/${summary.total})`);
  }
  // Fails closed regardless of minPassRate: an errored case was never judged,
  // so a tolerance for quality misses must not absorb it.
  if (summary.errored > 0) reasons.push(`${summary.errored} case(s) errored before a verdict`);
  if (thresholds.maxTotalCostUsd !== undefined) {
    if (summary.totalCostUsd === null) reasons.push(`total cost is unknown; the suite caps it at $${thresholds.maxTotalCostUsd}`);
    else if (summary.totalCostUsd > thresholds.maxTotalCostUsd) reasons.push(`total cost $${summary.totalCostUsd} exceeds $${thresholds.maxTotalCostUsd}`);
  }
  if (thresholds.maxP95LatencyMs !== undefined && summary.latencyMs.p95 > thresholds.maxP95LatencyMs) {
    reasons.push(`p95 latency ${summary.latencyMs.p95}ms exceeds ${thresholds.maxP95LatencyMs}ms`);
  }
  const regressions: string[] = [];
  if (baseline !== undefined) {
    for (const result of results) {
      if (baseline.outcomes.get(result.id) === 'pass' && result.outcome !== 'pass') regressions.push(result.id);
    }
    if (regressions.length > 0) reasons.push(`${regressions.length} case(s) regressed against the baseline: ${regressions.join(', ')}`);
  }
  return { pass: reasons.length === 0, reasons, regressions };
}

function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(p * sorted.length) - 1))]!;
}

function roundUsd(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function formatRate(rate: number): string {
  return `${Math.round(rate * 1000) / 10}%`;
}
