import { isDurableCompletionDetail, isLoweredCompletion } from './authored-completion.js';
import type { AuthoredFlowExecutionResult } from './authored-flow-executor.js';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import { isSurfaceCompletionReason } from './authored-step-output.js';
import { JournalFrameError, JournalProtocolError, type JournalClient } from './journal-client.js';
import type { RunOutcome } from './protocol.js';

/*
 * Reading an authored root back from its journal, and what a failed read
 * means. Only a definite answer from the daemon may change how a run is
 * treated; an unanswered, canceled or failed read decides nothing.
 */

const NO_ROOT_STEP = new Error('authored root journal has no root step');

export async function rootKernelStep(journal: JournalClient, runId: string): Promise<Record<string, unknown>> {
  const entries = (await journal.journalRead(runId, 1)).entries as Array<Record<string, unknown>>;
  const spawned = entries.find(entry => entry.entry_type === 'run.spawned');
  const payload = spawned?.payload as { spec?: { steps?: unknown[] } } | undefined;
  const step = payload?.spec?.steps?.[0];
  if (typeof step !== 'object' || step === null || Array.isArray(step)) throw NO_ROOT_STEP;
  return step as Record<string, unknown>;
}

/** Codes relayflowd uses when it failed to read its own storage (server/protocol.rs). */
const DAEMON_READ_FAILURES = new Set(['journal_write_failed', 'internal']);

/**
 * The root step of `runId`, or undefined when the daemon definitively answered
 * that it has none: a refusal of the read (run_not_found, an unreadable early
 * epoch, ...) or a journal without a root step. A daemon-side read failure, an
 * interruption or a cancellation propagates instead, so a delayed, canceled or
 * failing daemon never makes resume guess the declarative path.
 */
export async function rootStepIfPresent(journal: JournalClient, runId: string): Promise<Record<string, unknown> | undefined> {
  return rootKernelStep(journal, runId).catch(error => {
    if ((error instanceof JournalProtocolError && !DAEMON_READ_FAILURES.has(error.code)) || error === NO_ROOT_STEP) return undefined;
    throw error;
  });
}

/**
 * The stored result of a root the daemon already reports completed. If reading
 * it back is interrupted, the outcome is still known: say so, rather than
 * recasting a finished run as resumable.
 */
export function completedResult(journal: JournalClient, outcome: RunOutcome, rootRunId: string): Promise<AuthoredFlowExecutionResult & { readonly rootRunId: string }> {
  return completedRootResult(journal, rootRunId).catch(error => {
    // A bad frame or a journal with no stored result is a definite fact; any
    // other failure — interrupted, canceled, or a daemon-side read error such
    // as journal_write_failed — left the verdict unread, not the run unfinished.
    if (error instanceof JournalFrameError || error === NO_DURABLE_RESULT) throw error;
    // The kernel completes the root step with success whatever the body
    // declared; the authored verdict lives only in the unread output.
    const unread = new AuthoredFlowExecutionError('result_unreadable',
      `run ${rootRunId} completed, but its stored result (the flow's verdict) could not be read: ${error.message}`,
      undefined, rootRunId);
    unread.rootRunId = rootRunId;
    throw unread;
  });
}

const NO_DURABLE_RESULT = new Error('completed authored root has no durable result');

async function completedRootResult(
  journal: JournalClient,
  rootRunId: string,
): Promise<AuthoredFlowExecutionResult & { readonly rootRunId: string }> {
  const entries = (await journal.journalRead(rootRunId, 1)).entries as Array<Record<string, unknown>>;
  const completed = entries.slice().reverse().find(entry => entry.entry_type === 'step.completed'
    && entry.step_id === 'authored-root'
    && (entry.payload as { completionReason?: unknown } | undefined)?.completionReason === 'success');
  const output = (completed?.payload as { output?: unknown } | undefined)?.output;
  if (!isCompletedRootOutput(output)) throw NO_DURABLE_RESULT;
  // The stored detail, never a freshly computed one: redaction reads the
  // CURRENT environment, so recomputing here would let a completed run report
  // something its journal does not hold.
  return Object.freeze({
    name: output.name,
    completionReason: output.completionReason,
    ...(output.completionDetail === undefined ? {} : { completionDetail: output.completionDetail }),
    journalSteps: Object.freeze(output.journalSteps.map(step => Object.freeze({ ...step }))),
    rootRunId,
  });
}

function isCompletedRootOutput(value: unknown): value is Omit<AuthoredFlowExecutionResult, 'rootRunId'> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const output = value as Partial<AuthoredFlowExecutionResult>;
  return typeof output.name === 'string'
    && isLoweredCompletion(output.completionReason)
    // A malformed detail fails the whole readback rather than being dropped:
    // silently discarding it would report the verdict without the evidence
    // the journal says it was recorded with.
    && (output.completionDetail === undefined || isDurableCompletionDetail(output.completionDetail))
    && Array.isArray(output.journalSteps)
    && output.journalSteps.every(step => typeof step === 'object' && step !== null
      && typeof step.id === 'string' && typeof step.runId === 'string'
      && isSurfaceCompletionReason(step.completionReason));
}
