// The data a flow evaluation exchanges: what an executor returns for one run,
// and the report the evaluation produces. Types only.

import type { FlowEvalCase } from './flow-eval-suite.js';
import type { JsonValue } from './json-value.js';
import type { FlowEvalTarget } from './flow-eval-version.js';

export const FLOW_EVAL_REPORT_SCHEMA_VERSION = 1;

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
  /**
   * `success`, `declined`, `step_failed`, `budget_exceeded`, `canceled`,
   * `needs_human`, `worker_unavailable` (parked with nothing attached to run
   * it), or `refused` (preflight refused the run).
   */
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
  /** The sealed snapshot to execute (a path inside it, or the in-memory spec), never the working tree. */
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
  /** `files`: the local sources the version covers, relative to the entry's directory. */
  flow: { path?: string; version: string; files: string[] };
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
