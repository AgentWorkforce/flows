// What a Cloud run record has to say before this client will act on it.
//
// One validator, two callers. `waitForCloudFlowRun` (cloud-run.ts) blocks on
// it to decide when a hosted `flows run --wait` is over, and the live read
// verbs (cli/cloud-live.ts, through `getCloudRunDetailLive`) block on it to
// decide when `--watch` and `--follow` stop and with which exit code. Both
// have to mean the same thing by "this run is over, and it ended well", or a
// watch would exit 0 on a record the waiter refuses.
//
// Deliberately strict and deliberately separate from the *permissive*
// `getCloudRunDetail` mapping, which exists to show a reader whatever Cloud
// said. Attesting an outcome is a different job to rendering one: a
// `completed` header with no valid `completionReason` attests nothing, and
// must not become exit 0.

import { RUN_COMPLETION_REASONS } from '@relayflows/surface';
import { CloudFlowError, isCloudRecord } from './cloud-http.js';
import type { RunCompletionReason } from './protocol.js';

export type CloudRunState =
  | { runId: string; status: 'pending' | 'launching' | 'running' }
  | { runId: string; status: 'completed' | 'failed' | 'cancelled'; completionReason: RunCompletionReason };

/** The statuses that mean the hosted run has not finished. */
const ACTIVE_RUN_STATUSES: readonly string[] = ['pending', 'launching', 'running'];

/**
 * Is this run still going?
 *
 * The one vocabulary for the question, so `run --cloud --wait`,
 * `status --cloud --watch` and `logs --follow` cannot disagree about what
 * `launching` means. Note this is about the *run*: a `needs_human` step is
 * not a run status and never reaches here.
 */
export function isCloudRunActive(status: string): boolean {
  return ACTIVE_RUN_STATUSES.includes(status);
}

/**
 * Validate a raw run record into an execution outcome, or refuse.
 *
 * Takes the body as Cloud answered it so a caller that also wants the
 * renderable projection can make one request and validate the same bytes it
 * rendered, rather than issuing a second GET per poll.
 */
export function cloudRunState(body: unknown, runId: string): CloudRunState {
  if (!isCloudRecord(body) || body.runId !== runId || body.relayflowVersion !== 'v2'
    || typeof body.status !== 'string'
    || !['pending', 'launching', 'running', 'completed', 'failed', 'cancelled'].includes(body.status)) {
    throw new CloudFlowError('invalid_response', 'Cloud returned an invalid v2 run record.');
  }
  if (isCloudRunActive(body.status)) {
    return { runId, status: body.status as 'pending' | 'launching' | 'running' };
  }
  const report = body.result;
  const reason = isCloudRecord(report) ? report.completionReason : undefined;
  if (typeof reason !== 'string' || !(RUN_COMPLETION_REASONS as readonly string[]).includes(reason)
    || (body.status === 'completed' && (reason !== 'success' || !isCloudRecord(report) || report.ok !== true || report.status !== 'completed'))
    || (body.status === 'failed' && !['step_failed', 'budget_exceeded'].includes(reason))
    || (body.status === 'cancelled' && reason !== 'canceled')) {
    throw new CloudFlowError('invalid_response', 'Cloud terminal record lacks a valid, consistent run completionReason; no execution outcome is attested.');
  }
  return { runId, status: body.status as 'completed' | 'failed' | 'cancelled', completionReason: reason as RunCompletionReason };
}
