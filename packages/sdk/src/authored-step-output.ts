import { COMPLETION_REASONS, RUN_COMPLETION_REASONS } from '@relayflows/surface';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import type { JournalClient } from './journal-client.js';
import type { CompletionReason as ProtocolCompletionReason, RunCompletionReason as ProtocolRunCompletionReason, RunOutcome } from './protocol.js';
import type { AuthoredFlowJournalStep } from './authored-flow-executor.js';

/**
 * Shared by every `f.*` verb that lowers to one kernel step run in isolation:
 * find its `step.completed` entry, record it, and refuse anything but a
 * clean success before handing the raw `output` back for verb-specific
 * extraction (a plain string for `f.run`, an `AgentResult` for `f.agent`).
 *
 * Callers are responsible for having already established that the RUN
 * reached a terminal, successful state before calling this — `f.run`'s
 * caller relies on `runStart`'s own immediate response (the kernel drives a
 * deterministic step to completion inline, no race); `f.agent`'s caller
 * relies on `classifyOutcome` (cli/run.ts) having already polled to a true
 * terminal state. Given that, a single read from the start of this run's
 * (small, single-step) journal is enough — no polling here, and no run
 * outcome ever needs re-checking.
 */
export async function readCompletedStepOutput(
  journal: JournalClient,
  runId: string,
  stepId: string,
  journalSteps: AuthoredFlowJournalStep[],
): Promise<unknown> {
  const entries = (await journal.journalRead(runId, 1)).entries;
  const completed = entries.find((entry) => isStepCompleted(entry, stepId));
  if (!isStepCompleted(completed, stepId)) {
    throw protocolViolation(runId, `journal has no step.completed for "${stepId}"`);
  }

  const reason = completed.payload.completionReason;
  journalSteps.push(Object.freeze({ id: stepId, runId, completionReason: reason }));
  if (reason !== 'success') {
    throw new AuthoredFlowExecutionError(
      'step_failed',
      `journal step "${stepId}" completed with ${reason}`,
      reason,
      runId,
    );
  }
  return completed.payload.output;
}

export async function readSuccessfulOutput(
  journal: JournalClient,
  outcome: RunOutcome,
  stepId: string,
  journalSteps: AuthoredFlowJournalStep[],
): Promise<string> {
  const output = await readCompletedStepOutput(journal, outcome.run_id, stepId, journalSteps);
  if (!isRecord(output) || typeof output['stdout_tail'] !== 'string') {
    throw protocolViolation(outcome.run_id, `step "${stepId}" has no string stdout_tail`);
  }
  return output['stdout_tail'];
}

interface StepCompletedEntry {
  entry_type: 'step.completed';
  step_id: string;
  payload: {
    completionReason: ProtocolCompletionReason;
    output: unknown;
  };
}

function isStepCompleted(value: unknown, stepId: string): value is StepCompletedEntry {
  if (!isRecord(value) || value['entry_type'] !== 'step.completed' || value['step_id'] !== stepId) {
    return false;
  }
  const payload = value['payload'];
  return isRecord(payload)
    && isSurfaceCompletionReason(payload['completionReason'])
    && 'output' in payload;
}

export function isSurfaceCompletionReason(value: unknown): value is ProtocolCompletionReason {
  return typeof value === 'string'
    && (COMPLETION_REASONS as readonly string[]).includes(value);
}

export function isSurfaceRunCompletionReason(value: unknown): value is ProtocolRunCompletionReason {
  return typeof value === 'string'
    && (RUN_COMPLETION_REASONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function protocolViolation(runId: string, detail: string): AuthoredFlowExecutionError {
  return new AuthoredFlowExecutionError(
    'journal_protocol_violation',
    detail,
    undefined,
    runId,
  );
}
