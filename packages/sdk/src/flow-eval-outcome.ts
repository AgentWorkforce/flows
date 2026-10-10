// One vocabulary for a finished run's verdict, whoever ran it: a local
// `flows run` report and a hosted run's stored result are the same RunReport
// shape, and must map to the same completion reason, or a suite would pass
// locally and fail on Cloud for the same flow behavior.

import type { FlowEvalRun } from './flow-eval-report.js';

/** The fields of a `RunReport` the verdict reads. */
export interface RunReportVerdict {
  ok?: unknown;
  status?: unknown;
  completionReason?: unknown;
  completionDetail?: unknown;
  parkCause?: unknown;
  diagnostics?: unknown;
}

/**
 * Map a run report onto the eval vocabulary.
 *
 * - `declined`: the report says `success` with a `run_declined` diagnostic —
 *   the body chose not to act. Scoring it as `success` would let a flow that
 *   did nothing pass a suite expecting it to act.
 * - `worker_unavailable` vs `needs_human`: both park (exit 3); only the second
 *   reached a human wait.
 * - `refused`: preflight refused the run (exit 2); nothing executed.
 */
export function runReportOutcome(report: RunReportVerdict, exitCode?: number): Pick<FlowEvalRun, 'completionReason' | 'completionDetail'> {
  const diagnostics = Array.isArray(report.diagnostics)
    ? report.diagnostics.filter((d): d is Record<string, unknown> => d !== null && typeof d === 'object') : [];
  const message = diagnostics.find(d => ['failure', 'refusal', 'parked'].includes(d['severity'] as string))?.['message'];
  const detail = typeof report.completionDetail === 'string' ? report.completionDetail
    : typeof message === 'string' ? message : undefined;
  let completionReason: string;
  if (exitCode === 2) completionReason = 'refused';
  else if (report.status === 'parked' || exitCode === 3) {
    completionReason = report.parkCause === 'worker_unavailable' ? 'worker_unavailable' : 'needs_human';
  } else if (report.ok === true && diagnostics.some(d => d['kind'] === 'run_declined')) completionReason = 'declined';
  else if (report.ok === true) completionReason = 'success';
  else if (typeof report.completionReason === 'string') completionReason = report.completionReason;
  else completionReason = report.status === 'suspended' ? 'suspended' : 'failed';
  return { completionReason, ...(detail === undefined ? {} : { completionDetail: detail }) };
}
