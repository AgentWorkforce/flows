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
 * Shared by every `f.*` verb that lowers to its own kernel run: find the
 * operation's `step.completed` entry, record it, and refuse anything but a
 * clean success before handing the raw `output` back for verb-specific
 * extraction (a plain string for `f.run`, an `AgentResult` for `f.agent`).
 *
 * Callers are responsible for having already waited for the run to reach a
 * terminal state — `f.run`'s caller relies on `runStart`'s own immediate
 * response (the kernel drives a deterministic step to completion inline, no
 * race); `f.agent`'s caller relies on `classifyOutcome` (cli/run.ts) having
 * already polled to one. Given that, a single read from the start of this
 * run's small journal is enough, and no polling happens here.
 *
 * What is NOT delegated to the caller is the run's verdict. A child spec has
 * more than one step whenever the author declared a `.gate()`, and that gate
 * step runs after the producer, so the producer's own `success` is not the
 * run's. Both are checked here, and the run-level check is what makes a failed
 * gate reject the authored operation.
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
    throw await stepFailure(journal, runId, stepId, reason, context,
      `journal step "${stepId}" completed with ${reason}`);
  }
  // An authored operation does not always lower to ONE kernel step. A declared
  // `.gate()` becomes its own barrier step that runs AFTER the producer
  // (`lowerNamedGates`), so the producer's own success is not the run's
  // verdict. Reading only the producer's entry let a failed gate resolve as
  // though the command had passed — the `|| true` invisibility this module's
  // recording policy exists to remove, reappearing one layer up.
  const runReason = entries.map(runCompletionReason).find((value) => value !== undefined);
  if (runReason !== undefined && runReason !== 'success') {
    throw await stepFailure(journal, runId, stepId, runReason, context,
      `journal run for step "${stepId}" completed with ${runReason}`);
  }
  await recordAuthoredChild(journal, context.rootRunId, {
    step: stepId, runId, state: 'completed', completionReason: reason,
  });
  return completed.payload.output;
}

/**
 * The one `step_failed` grammar both the step-level and the run-level refusal
 * report through: inspect the journal for the step that actually failed, render
 * its evidence, name where to look, and index the child before throwing.
 */
async function stepFailure(
  journal: JournalClient,
  runId: string,
  stepId: string,
  reason: ProtocolCompletionReason | ProtocolRunCompletionReason,
  context: AuthoredStepContext,
  header: string,
): Promise<AuthoredFlowExecutionError> {
  let message = header;
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
  return new AuthoredFlowExecutionError('step_failed', message, reason, runId, { ...details, ...where });
}

export async function readSuccessfulOutput(
  journal: JournalClient,
  outcome: RunOutcome,
  stepId: string,
  journalSteps: AuthoredFlowJournalStep[],
  context: AuthoredStepContext = {},
): Promise<string> {
  const output = await readCompletedStepOutput(journal, outcome.run_id, stepId, journalSteps, context)
    .catch(relabelCommandTimeout(stepId));
  if (!isRecord(output) || typeof output['stdout_tail'] !== 'string') {
    throw protocolViolation(outcome.run_id, `step "${stepId}" has no string stdout_tail`);
  }
  return output['stdout_tail'];
}

/** What `f.run` resolves to under `onNonZero: 'record'` (surface `RunResult`). */
export interface RecordedRunOutcome {
  ok: boolean;
  exitCode: number;
  output: string;
  stdout: string;
  stderr: string;
}

/**
 * The read side of `onNonZero: 'record'`.
 *
 * A recorded red exit is a SUCCESSFUL step, so this takes the same path as
 * `readSuccessfulOutput` and every field comes from the journaled envelope —
 * nothing is re-run and nothing is re-measured. What still throws is what the
 * policy never covered: a timeout, a signal, a step that never ran, or a
 * declared content or schema gate that failed. The `-1` the executor writes
 * for "no exit status" is refused rather than handed back as a plausible
 * code, mirroring the kernel's own rule, so a malformed envelope can never
 * reach an author's `if (!result.ok)` as a real verdict.
 */
export async function readRecordedOutcome(
  journal: JournalClient,
  outcome: RunOutcome,
  stepId: string,
  journalSteps: AuthoredFlowJournalStep[],
  context: AuthoredStepContext = {},
): Promise<RecordedRunOutcome> {
  const envelope = await readCompletedStepOutput(journal, outcome.run_id, stepId, journalSteps, context)
    .catch(relabelCommandTimeout(stepId));
  const exitCode = isRecord(envelope) ? envelope['exit_code'] : undefined;
  if (!isRecord(envelope) || typeof envelope['stdout_tail'] !== 'string'
    || typeof envelope['stderr_tail'] !== 'string'
    || typeof exitCode !== 'number' || !Number.isInteger(exitCode) || exitCode < 0) {
    throw protocolViolation(outcome.run_id,
      `step "${stepId}" recorded no {exit_code, stdout_tail, stderr_tail} to report`);
  }
  const stdout = envelope['stdout_tail'];
  const stderr = envelope['stderr_tail'];
  return {
    ok: exitCode === 0, exitCode, stdout, stderr,
    // Concatenated, not interleaved: the two tails were captured separately,
    // so joining them is a reading convenience and is documented as one.
    output: stdout !== '' && stderr !== '' ? `${stdout}\n${stderr}` : stdout + stderr,
  };
}

/** A timeout is still a failed command; re-labelling it must not delete its evidence. */
function relabelCommandTimeout(stepId: string): (error: unknown) => never {
  return (error) => {
    if (error instanceof AuthoredFlowExecutionError
      && (error.completionReason === 'timeout' || error.completionReason === 'lease_expired')) {
      throw new AuthoredFlowExecutionError('lease_exceeded',
        `f.run step "${stepId}" exceeded its command timeout.`
          + ` ${error.message.slice(`${error.code}: `.length)}`,
        error.completionReason, error.runId, error.details);
    }
    throw error;
  };
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

/**
 * The run's own terminal reason, when this entry is the one carrying it.
 *
 * Anything else — including a `run.completed` whose payload this reader does
 * not recognise — yields `undefined` and leaves the step-level verdict
 * untouched, so an unfamiliar journal shape cannot invent a failure.
 */
function runCompletionReason(entry: unknown): ProtocolRunCompletionReason | undefined {
  if (!isRecord(entry) || entry['entry_type'] !== 'run.completed') return undefined;
  const payload = entry['payload'];
  const reason = isRecord(payload) ? payload['completionReason'] : undefined;
  return isSurfaceRunCompletionReason(reason) ? reason : undefined;
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
