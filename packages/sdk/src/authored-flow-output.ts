import { COMPLETION_REASONS, type AgentResult } from '@relayflows/surface';
import type { JournalClient } from './journal-client.js';
import type { CompletionReason as ProtocolCompletionReason, RunOutcome } from './protocol.js';
import type { AuthoredFlowJournalStep } from './authored-flow-executor.js';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';

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
 * `journalSteps` records observed journal facts, not successful output
 * conversions: a valid completion is appended before checking its reason or
 * decoding output. A later refusal must not erase that fact. Missing or
 * malformed completion entries append nothing. Execution propagates errors
 * and does not return a successful result or automatically retry this read.
 */
async function readCompletedStepOutput(
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

/**
 * The kernel journals an agent step's raw `CliResult` shape
 * (`exit_code`/`stdout_tail`/`stderr_tail`) — same as a deterministic step —
 * UNLESS the CLI's stdout parsed as JSON, in which case `output` is that
 * parsed object directly (worker.ts: `parseJsonOutput(result.stdout_tail) ??
 * result`). Neither shape carries a real `artifacts` list today: nothing in
 * the kernel or worker enumerates files an agent wrote, and `f.agent`'s
 * `AgentOptions` has no `output` schema parameter for a CLI to target either
 * (unlike the declarative `AgentStepSpec.output` field). `artifacts` is
 * therefore always empty here — honest about what data exists, not a
 * placeholder for something not yet wired.
 */
export async function readSuccessfulAgentOutput(
  journal: JournalClient,
  runId: string,
  stepId: string,
  journalSteps: AuthoredFlowJournalStep[],
): Promise<AgentResult> {
  const output = await readCompletedStepOutput(journal, runId, stepId, journalSteps);
  if (!isRecord(output)) {
    throw protocolViolation(runId, `step "${stepId}" produced a non-object output`);
  }
  if (typeof output['stdout_tail'] === 'string') {
    return { summary: output['stdout_tail'], artifacts: [] };
  }
  // The CLI's stdout parsed as JSON, so `output` is that value, not a
  // CliResult. Fall back to a stable, inspectable summary rather than
  // refusing a run whose agent step genuinely succeeded.
  return { summary: JSON.stringify(output), artifacts: [] };
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
