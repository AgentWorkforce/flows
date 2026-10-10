// The frozen input set of a flow evaluation: its shape, strict parsing of
// untrusted suite JSON, and its identity hash.

import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalize } from './canonical.js';
import { FlowEvalError } from './flow-eval-error.js';
import { snapshotJsonValue, type JsonValue } from './json-value.js';

export const MAX_FLOW_EVAL_CASES = 1_000;

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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
