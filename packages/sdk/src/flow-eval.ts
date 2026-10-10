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
// exactly what it judged: the flow version (sha256 of the source bytes, or of
// the compiled spec for an in-memory FlowSpec) and the suite (sha256 of its
// canonical JSON). A caller pinning either refuses to evaluate anything else.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalize, specHash } from './canonical.js';
import { compileSpec, toKernelSpec } from './compile.js';
import type { FlowSpec } from './spec.js';
import { snapshotJsonValue, type JsonValue } from './json-value.js';

export const FLOW_EVAL_REPORT_SCHEMA_VERSION = 1;
export const MAX_FLOW_EVAL_CASES = 1_000;

/** A flow source path (`.flow.ts`, `.flow.yaml`, spec JSON) or an in-memory spec. */
export type FlowEvalTarget = { path: string } | FlowSpec;

/** What a case must observe to pass. Every field present must hold. */
export interface FlowEvalExpectation {
  /**
   * The run's outcome. Defaults to `success`. `declined` is a successful run
   * whose body chose not to act; `needs_human` is a parked run.
   */
  completionReason?: string;
  /** Substrings the run's completion detail must contain. */
  detailIncludes?: string[];
  /** A regular expression (JavaScript syntax) the completion detail must match. */
  detailMatches?: string;
  /** Upper bound on this case's wall-clock latency. */
  maxLatencyMs?: number;
  /** Upper bound on this case's reported cost; an unknown cost fails it. */
  maxCostUsd?: number;
}

export interface FlowEvalCase {
  /** Stable identity across suite revisions; unique within the suite. */
  id: string;
  /** The run's input. Required by authored `.flow.ts`; refused by declarative specs on Cloud. */
  input?: JsonValue;
  expect?: FlowEvalExpectation;
}

export interface FlowEvalThresholds {
  /** Fraction of cases that must pass, 0..1. Defaults to 1: every case. */
  minPassRate?: number;
  /** Ceiling on the summed cost of every case; an unknown cost fails it. */
  maxTotalCostUsd?: number;
  /** Ceiling on the 95th-percentile case latency. */
  maxP95LatencyMs?: number;
}

export interface FlowEvalSuite {
  name: string;
  cases: FlowEvalCase[];
  thresholds?: FlowEvalThresholds;
}

/** One step of an executed case, as far as the executor can say. */
export interface FlowEvalStep {
  id: string;
  status: string;
  durationMs?: number | null;
  costUsd?: number | null;
}

/** What an executor reports for one execution. */
export interface FlowEvalRun {
  runId?: string;
  /** `success`, `declined`, `step_failed`, `budget_exceeded`, `canceled`, `needs_human`, or `refused`. */
  completionReason: string;
  completionDetail?: string;
  /** `null` when the executor cannot attest a dollar cost. */
  costUsd?: number | null;
  tokensIn?: number | null;
  tokensOut?: number | null;
  steps?: FlowEvalStep[];
  /** Executor-supplied numeric metrics, merged into the case's metrics. */
  metrics?: Record<string, number>;
}

export interface FlowEvalExecutionRequest {
  flow: FlowEvalTarget;
  caseId: string;
  /** Absent when the case declares no input. */
  input?: JsonValue;
  signal?: AbortSignal;
}

/** Executes the flow once. Throwing marks the case `error`, never `pass`. */
export type FlowEvalExecutor = (request: FlowEvalExecutionRequest) => Promise<FlowEvalRun>;

export interface FlowEvalScore {
  /** Numeric value recorded under the scorer's name in the case's metrics. */
  value?: number;
  /** False fails the case. Absent means the scorer only measures. */
  pass?: boolean;
  detail?: string;
}

/** A caller-defined metric over one executed case. */
export interface FlowEvalScorer {
  name: string;
  score(run: FlowEvalRun, testCase: FlowEvalCase): FlowEvalScore | Promise<FlowEvalScore>;
}

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
   * A prior report on the same suite. Any case that passed there and does not
   * pass here is a regression, and a regression fails the gate.
   */
  baseline?: FlowEvalReport;
  signal?: AbortSignal;
  /** Clock injection for tests. */
  now?: () => number;
}

export type FlowEvalOutcome = 'pass' | 'fail' | 'error';

export interface FlowEvalCaseResult {
  id: string;
  outcome: FlowEvalOutcome;
  runId?: string;
  completionReason?: string;
  latencyMs: number;
  costUsd: number | null;
  tokensIn: number | null;
  tokensOut: number | null;
  metrics: Record<string, number>;
  steps?: FlowEvalStep[];
  /** Why the case did not pass; empty when it did. */
  failures: string[];
}

export interface FlowEvalReport {
  schemaVersion: typeof FLOW_EVAL_REPORT_SCHEMA_VERSION;
  kind: 'flows.eval.report';
  flow: { path?: string; version: string };
  suite: { name: string; sha256: string; cases: number };
  executor: string;
  startedAt: string;
  finishedAt: string;
  cases: FlowEvalCaseResult[];
  summary: {
    total: number;
    passed: number;
    failed: number;
    errored: number;
    passRate: number;
    /** `null` when any case's cost is unknown. */
    totalCostUsd: number | null;
    latencyMs: { p50: number; p95: number; max: number };
  };
  /** The deploy decision: pass only when every threshold and regression check holds. */
  gate: { pass: boolean; reasons: string[]; regressions: string[] };
}

export type FlowEvalErrorCode = 'invalid_suite' | 'version_mismatch' | 'suite_mismatch' | 'invalid_options' | 'unreadable_flow';

export class FlowEvalError extends Error {
  constructor(readonly code: FlowEvalErrorCode, message: string) {
    super(message);
    this.name = 'FlowEvalError';
  }
}

/** Validate untrusted suite data (parsed JSON) into a frozen suite. */
export function parseFlowEvalSuite(value: unknown): FlowEvalSuite {
  const fail = (message: string): never => { throw new FlowEvalError('invalid_suite', message); };
  if (!isRecord(value)) fail('Suite must be a JSON object.');
  const raw = value as Record<string, unknown>;
  allowOnly(raw, ['name', 'cases', 'thresholds'], 'suite', fail);
  if (typeof raw.name !== 'string' || raw.name.trim() === '') fail('Suite needs a nonempty `name`.');
  if (!Array.isArray(raw.cases) || raw.cases.length === 0) fail('Suite needs a nonempty `cases` array.');
  const rawCases = raw.cases as unknown[];
  if (rawCases.length > MAX_FLOW_EVAL_CASES) fail(`Suite has ${rawCases.length} cases; the limit is ${MAX_FLOW_EVAL_CASES}.`);
  const seen = new Set<string>();
  const cases = rawCases.map((entry, index): FlowEvalCase => {
    const at = `cases[${index}]`;
    if (!isRecord(entry)) fail(`${at} must be an object.`);
    const item = entry as Record<string, unknown>;
    allowOnly(item, ['id', 'input', 'expect'], at, fail);
    if (typeof item.id !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(item.id)) {
      fail(`${at}.id must be 1-128 characters of letters, digits, '.', '_', ':' or '-'.`);
    }
    const id = item.id as string;
    if (seen.has(id)) fail(`${at}.id "${id}" is not unique.`);
    seen.add(id);
    const testCase: FlowEvalCase = { id };
    if (Object.prototype.hasOwnProperty.call(item, 'input')) {
      try {
        testCase.input = snapshotJsonValue(item.input, `${at}.input`);
      } catch (error) {
        fail(`${at}.input is not JSON data: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (item.expect !== undefined) testCase.expect = parseExpectation(item.expect, `${at}.expect`, fail);
    return testCase;
  });
  const suite: FlowEvalSuite = { name: raw.name as string, cases };
  if (raw.thresholds !== undefined) {
    if (!isRecord(raw.thresholds)) fail('`thresholds` must be an object.');
    const t = raw.thresholds as Record<string, unknown>;
    allowOnly(t, ['minPassRate', 'maxTotalCostUsd', 'maxP95LatencyMs'], 'thresholds', fail);
    const thresholds: FlowEvalThresholds = {};
    if (t.minPassRate !== undefined) {
      if (typeof t.minPassRate !== 'number' || !(t.minPassRate >= 0 && t.minPassRate <= 1)) fail('`thresholds.minPassRate` must be a number from 0 to 1.');
      thresholds.minPassRate = t.minPassRate as number;
    }
    if (t.maxTotalCostUsd !== undefined) thresholds.maxTotalCostUsd = nonNegative(t.maxTotalCostUsd, 'thresholds.maxTotalCostUsd', fail);
    if (t.maxP95LatencyMs !== undefined) thresholds.maxP95LatencyMs = nonNegative(t.maxP95LatencyMs, 'thresholds.maxP95LatencyMs', fail);
    suite.thresholds = thresholds;
  }
  return suite;
}

/** Read and validate a suite file (JSON). */
export async function loadFlowEvalSuite(path: string): Promise<FlowEvalSuite> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch {
    throw new FlowEvalError('invalid_suite', `Suite file "${path}" is not readable.`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new FlowEvalError('invalid_suite', `Suite file "${path}" is not valid JSON.`);
  }
  return parseFlowEvalSuite(parsed);
}

/** The suite's identity: sha256 of its canonical JSON. */
export function flowEvalSuiteSha256(suite: FlowEvalSuite): string {
  return `sha256:${createHash('sha256').update(canonicalize(suite as unknown as JsonValue)).digest('hex')}`;
}

/**
 * The flow version an evaluation judges: sha256 of the source bytes for a
 * path, or the kernel spec hash for an in-memory spec. Byte identity on
 * purpose — a gate must judge exactly what will be deployed, comments included.
 */
export async function flowEvalVersion(flow: FlowEvalTarget): Promise<string> {
  if (isPathTarget(flow)) {
    let bytes: Buffer;
    try {
      bytes = await readFile(flow.path);
    } catch {
      throw new FlowEvalError('unreadable_flow', `Flow "${flow.path}" is not readable.`);
    }
    return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  }
  return `sha256:${specHash(toKernelSpec(compileSpec(flow)))}`;
}

/**
 * Re-execute `flow` once per suite case and score the results.
 *
 * Never throws for a case that fails or errors: those are verdicts, recorded
 * in the report. Throws `FlowEvalError` only when the evaluation itself is
 * invalid (bad suite or options, or a pinned version/suite that does not match),
 * and rethrows an abort.
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
  const version = await flowEvalVersion(options.flow);
  if (options.expectVersion !== undefined && options.expectVersion !== version) {
    throw new FlowEvalError('version_mismatch', `Flow version is ${version}; expected ${options.expectVersion}.`);
  }
  const suiteSha256 = flowEvalSuiteSha256(suite);
  if (options.expectSuiteSha256 !== undefined && options.expectSuiteSha256 !== suiteSha256) {
    throw new FlowEvalError('suite_mismatch', `Suite hashes to ${suiteSha256}; expected ${options.expectSuiteSha256}.`);
  }
  if (options.baseline !== undefined && options.baseline.suite.sha256 !== suiteSha256) {
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
      results[index] = await runCase(suite.cases[index]!, options, now);
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, suite.cases.length) }, worker));
  options.signal?.throwIfAborted();

  const summary = summarize(results);
  const gate = decideGate(suite, results, summary, options.baseline);
  return {
    schemaVersion: FLOW_EVAL_REPORT_SCHEMA_VERSION,
    kind: 'flows.eval.report',
    flow: { ...(isPathTarget(options.flow) ? { path: options.flow.path } : {}), version },
    suite: { name: suite.name, sha256: suiteSha256, cases: suite.cases.length },
    executor: options.executorName ?? 'custom',
    startedAt: new Date(startedAt).toISOString(),
    finishedAt: new Date(now()).toISOString(),
    cases: results,
    summary,
    gate,
  };
}

async function runCase(testCase: FlowEvalCase, options: EvaluateFlowOptions, now: () => number): Promise<FlowEvalCaseResult> {
  const started = now();
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

function summarize(results: readonly FlowEvalCaseResult[]): FlowEvalReport['summary'] {
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

function decideGate(
  suite: FlowEvalSuite,
  results: readonly FlowEvalCaseResult[],
  summary: FlowEvalReport['summary'],
  baseline: FlowEvalReport | undefined,
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
    const before = new Map(baseline.cases.map(c => [c.id, c.outcome]));
    for (const result of results) {
      if (before.get(result.id) === 'pass' && result.outcome !== 'pass') regressions.push(result.id);
    }
    if (regressions.length > 0) reasons.push(`${regressions.length} case(s) regressed against the baseline: ${regressions.join(', ')}`);
  }
  return { pass: reasons.length === 0, reasons, regressions };
}

function parseExpectation(value: unknown, at: string, fail: (message: string) => never): FlowEvalExpectation {
  if (!isRecord(value)) fail(`${at} must be an object.`);
  const raw = value as Record<string, unknown>;
  allowOnly(raw, ['completionReason', 'detailIncludes', 'detailMatches', 'maxLatencyMs', 'maxCostUsd'], at, fail);
  const expect: FlowEvalExpectation = {};
  if (raw.completionReason !== undefined) {
    if (typeof raw.completionReason !== 'string' || raw.completionReason === '') fail(`${at}.completionReason must be a nonempty string.`);
    expect.completionReason = raw.completionReason as string;
  }
  if (raw.detailIncludes !== undefined) {
    if (!Array.isArray(raw.detailIncludes) || raw.detailIncludes.some(item => typeof item !== 'string')) fail(`${at}.detailIncludes must be an array of strings.`);
    expect.detailIncludes = [...(raw.detailIncludes as string[])];
  }
  if (raw.detailMatches !== undefined) {
    if (typeof raw.detailMatches !== 'string') fail(`${at}.detailMatches must be a string.`);
    try {
      new RegExp(raw.detailMatches as string, 'u');
    } catch {
      fail(`${at}.detailMatches is not a valid regular expression.`);
    }
    expect.detailMatches = raw.detailMatches as string;
  }
  if (raw.maxLatencyMs !== undefined) expect.maxLatencyMs = nonNegative(raw.maxLatencyMs, `${at}.maxLatencyMs`, fail);
  if (raw.maxCostUsd !== undefined) expect.maxCostUsd = nonNegative(raw.maxCostUsd, `${at}.maxCostUsd`, fail);
  return expect;
}

function allowOnly(raw: Record<string, unknown>, keys: readonly string[], at: string, fail: (message: string) => never): void {
  for (const key of Object.keys(raw)) if (!keys.includes(key)) fail(`${at} has unknown field "${key}".`);
}

function nonNegative(value: unknown, at: string, fail: (message: string) => never): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(`\`${at}\` must be a non-negative number.`);
  return value as number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isPathTarget(flow: FlowEvalTarget): flow is { path: string } {
  return typeof (flow as { path?: unknown }).path === 'string' && !('steps' in flow);
}

function finiteOrNull(value: number | null | undefined): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
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

function truncate(text: string): string {
  const line = text.replace(/\s+/gu, ' ').trim();
  return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}
