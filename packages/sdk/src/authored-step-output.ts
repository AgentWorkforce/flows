import { COMPLETION_REASONS, RUN_COMPLETION_REASONS, FLOW_COMPLETION_REASONS, type FlowCompletionReason } from '@relayflows/surface';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import type { JournalClient } from './journal-client.js';
import type { CompletionReason as ProtocolCompletionReason, RunCompletionReason as ProtocolRunCompletionReason, RunOutcome } from './protocol.js';
import type { AuthoredFlowJournalStep } from './authored-flow-executor.js';
import type { StepFailedDetails } from './failure-kinds.js';
import { inspectionHint, renderInspection, renderStepEvidence, stepFailureDetails } from './cli/step-failure.js';
import { alsoRecord, recordAuthoredChild } from './authored-step-index.js';

/**
 * What an authored operation needs in order to leave readable evidence:
 * the root run its child index belongs to, and the data dir whose journals
 * a reader would open. Both optional — the non-durable executor seam has no
 * root, and a caller that did not name a data dir still gets the `flows
 * replay <run-id>` hint, just without the on-disk path.
 */
export interface AuthoredStepContext {
  readonly rootRunId?: string;
  readonly dataDir?: string;
}

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
 *
 * A non-success completion used to throw `journal step "run-1" completed with
 * retries_exhausted` and stop there, discarding the evidence it was holding:
 * the kernel PRESERVES a failed deterministic step's `output`
 * (`preserve_failure_output`, relayflowd-core/src/machine.rs), so
 * `{exit_code, stdout_tail, stderr_tail}` — the answer to "which command
 * failed and what did it print" — was in hand and dropped. Four different
 * causes produced that one identical line. It now reads the same extractor
 * `f.agent`/`f.llm` already reach through `classifyOutcome`, so both step
 * families report one grammar instead of two divergent ones.
 */
export async function readCompletedStepOutput(
  journal: JournalClient,
  runId: string,
  stepId: string,
  journalSteps: AuthoredFlowJournalStep[],
  context: AuthoredStepContext = {},
): Promise<unknown> {
  const entries = (await journal.journalRead(runId, 1)).entries;
  const completed = entries.find((entry) => isStepCompleted(entry, stepId));
  if (!isStepCompleted(completed, stepId)) {
    throw protocolViolation(runId, `journal has no step.completed for "${stepId}"`);
  }

  const reason = completed.payload.completionReason;
  journalSteps.push(Object.freeze({ id: stepId, runId, completionReason: reason }));
  if (reason !== 'success') {
    let message = `journal step "${stepId}" completed with ${reason}`;
    let details: StepFailedDetails | undefined;
    try {
      details = await stepFailureDetails(journal, runId);
    } catch (error) {
      // Inspection must not erase the already known step failure; the two
      // failures stay separately visible, as in classifyOutcome.
      message += ` Could not inspect the failed step: ${errorMessage(error)}`;
    }
    if (details !== undefined) message += renderStepEvidence(details);
    // Appended whatever inspection found — including nothing. A failure shape
    // this reader does not recognise must still end with somewhere to go.
    const where = inspectionHint(runId, details?.stepId ?? stepId, context.dataDir);
    message += renderInspection(where);
    message += await alsoRecord(journal, context.rootRunId, {
      step: stepId, runId, state: 'completed', completionReason: reason,
      ...(details?.stepId === undefined ? {} : { kernelStep: details.stepId }),
    });
    throw new AuthoredFlowExecutionError('step_failed', message, reason, runId, { ...details, ...where });
  }
  await recordAuthoredChild(journal, context.rootRunId, {
    step: stepId, runId, state: 'completed', completionReason: reason,
  });
  return completed.payload.output;
}

export async function readSuccessfulOutput(
  journal: JournalClient,
  outcome: RunOutcome,
  stepId: string,
  journalSteps: AuthoredFlowJournalStep[],
  context: AuthoredStepContext = {},
): Promise<string> {
  const output = await readCompletedStepOutput(journal, outcome.run_id, stepId, journalSteps, context)
    .catch(error => {
      if (error instanceof AuthoredFlowExecutionError
        && (error.completionReason === 'timeout' || error.completionReason === 'lease_expired')) {
        // A timeout is still a failed command, and the evidence extracted for
        // it is the same evidence. Re-labelling the error must not delete it.
        throw new AuthoredFlowExecutionError('lease_exceeded',
          `f.run step "${stepId}" exceeded its command timeout.`
            + ` ${error.message.slice(`${error.code}: `.length)}`,
          error.completionReason, error.runId, error.details);
      }
      throw error;
    });
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

export function isSurfaceFlowCompletionReason(value: unknown): value is FlowCompletionReason {
  return typeof value === 'string'
    && (FLOW_COMPLETION_REASONS as readonly string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function protocolViolation(runId: string, detail: string): AuthoredFlowExecutionError {
  return new AuthoredFlowExecutionError(
    'journal_protocol_violation',
    detail,
    undefined,
    runId,
  );
}
