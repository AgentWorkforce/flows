import {
  COMPLETION_REASONS,
  RUN_COMPLETION_REASONS,
  type AgentResult,
  type CloudHelper,
  type CompletionReason as SurfaceCompletionReason,
  type Ctx,
  type RunCompletionReason as SurfaceRunCompletionReason,
  type Step,
} from '@relayflows/surface';
import type { FlowHandle } from '@relayflows/surface/runtime';
import { compileSpec, toKernelSpec } from './compile.js';
import { getAuthoredFlowDefinition } from './authored-flow.js';
import {
  AuthoredFlowExecutionError,
  type AuthoredFlowExecutionErrorCode,
} from './authored-flow-error.js';
import {
  AuthoredFlowOperation,
  stopAuthoredOperations,
  verifyAuthoredOperations,
} from './authored-flow-operation.js';
import { JournalClient } from './journal-client.js';
import type {
  CompletionReason as ProtocolCompletionReason,
  RunCompletionReason as ProtocolRunCompletionReason,
  RunOutcome,
} from './protocol.js';
import { SPEC_SCHEMA_VERSION } from './spec.js';

type Assert<T extends true> = T;
type Equal<A, B> = [A] extends [B]
  ? ([B] extends [A] ? true : false)
  : false;
type CompletionVocabularyMatchesProtocol = Assert<
  Equal<SurfaceCompletionReason, ProtocolCompletionReason>
>;
type RunCompletionVocabularyMatchesProtocol = Assert<
  Equal<SurfaceRunCompletionReason, ProtocolRunCompletionReason>
>;
type DoneCompletionReason = Parameters<Ctx['done']>[0];
type DoneAcceptsOnlyRunCompletionReasons = Assert<
  DoneCompletionReason extends SurfaceRunCompletionReason ? true : false
>;
type EveryRunCompletionReasonIsAcceptedByDone = Assert<
  SurfaceRunCompletionReason extends DoneCompletionReason ? true : false
>;

export { AuthoredFlowExecutionError, type AuthoredFlowExecutionErrorCode };

export interface AuthoredFlowJournalStep {
  readonly id: string;
  readonly runId: string;
  readonly completionReason: ProtocolCompletionReason;
}

export interface AuthoredFlowExecutionResult {
  readonly name: string;
  readonly completionReason: ProtocolRunCompletionReason;
  readonly journalSteps: readonly AuthoredFlowJournalStep[];
}

type ExecutionResultUsesRunCompletionReason = Assert<
  Equal<AuthoredFlowExecutionResult['completionReason'], ProtocolRunCompletionReason>
>;
type JournalStepUsesStepCompletionReason = Assert<
  Equal<AuthoredFlowJournalStep['completionReason'], ProtocolCompletionReason>
>;

/**
 * Exercise the internal authored-flow lowering seam through protocol v0.
 *
 * This is deliberately not exported by the SDK package: without a durable
 * authored root, it is not a resumable public runner. The seam is narrow: an
 * empty-header flow may await plain `f.run(...)` steps and must finish with
 * `f.done("success")`. Every run and
 * the terminal marker is a compiled deterministic spec submitted through
 * `JournalClient`; values are read back from `step.completed` journal entries.
 * Unsupported headers, verbs, gates, or completion lowering fail closed.
 */
export async function executeAuthoredFlow(
  handle: FlowHandle,
  journal: JournalClient,
): Promise<AuthoredFlowExecutionResult> {
  const definition = getAuthoredFlowDefinition(handle);
  const headerFields = Object.keys(definition.header);
  if (headerFields.length > 0) {
    throw new AuthoredFlowExecutionError(
      'unsupported_header',
      `flow "${definition.name}" uses unsupported header fields: ${headerFields.join(', ')}`,
    );
  }

  const journalSteps: AuthoredFlowJournalStep[] = [];
  const authoredSteps: AuthoredFlowOperation<unknown>[] = [];
  let nextStep = 1;
  let requestedCompletion: SurfaceRunCompletionReason | undefined;

  const lowerDeterministic = async (
    id: string,
    command: string,
  ): Promise<string> => {
    const spec = toKernelSpec(compileSpec({
      version: SPEC_SCHEMA_VERSION,
      name: `${definition.name}/${id}`,
      steps: [{ id, type: 'deterministic', command }],
    }));
    const outcome = await journal.runStart(spec);
    return readSuccessfulOutput(journal, outcome, id, journalSteps);
  };

  const context: Ctx = {
    run(command) {
      assertOperationAllowed('run', definition.name, requestedCompletion);
      const id = `run-${nextStep++}`;
      return trackStep(authoredSteps, new AuthoredFlowOperation(
        id,
        'run',
        () => assertOperationAllowed('run', definition.name, requestedCompletion),
        () => lowerDeterministic(id, command),
      ));
    },
    llm() {
      assertOperationAllowed('llm', definition.name, requestedCompletion);
      const id = `llm-${nextStep++}`;
      return trackStep(authoredSteps, unsupportedStep(
        id,
        'llm',
        () => assertOperationAllowed('llm', definition.name, requestedCompletion),
      ));
    },
    agent() {
      assertOperationAllowed('agent', definition.name, requestedCompletion);
      const id = `agent-${nextStep++}`;
      return trackStep(authoredSteps, unsupportedStep<AgentResult>(
        id,
        'agent',
        () => assertOperationAllowed('agent', definition.name, requestedCompletion),
      ));
    },
    human() {
      assertOperationAllowed('human', definition.name, requestedCompletion);
      throw unsupportedVerb('human');
    },
    dispatch<T>() {
      assertOperationAllowed('dispatch', definition.name, requestedCompletion);
      throw unsupportedVerb('dispatch');
    },
    done(reason) {
      if (!isSurfaceRunCompletionReason(reason)) {
        throw new AuthoredFlowExecutionError(
          'unsupported_completion',
          `unknown completion reason: ${String(reason)}`,
        );
      }
      if (requestedCompletion !== undefined) {
        throw new AuthoredFlowExecutionError(
          'duplicate_completion',
          `flow "${definition.name}" called done() more than once`,
        );
      }
      if (reason !== 'success') {
        throw new AuthoredFlowExecutionError(
          'unsupported_completion',
          `the initial authored executor cannot lower done("${reason}")`,
          reason,
        );
      }
      requestedCompletion = reason;
    },
    cloud: unsupportedCloud(
      () => assertOperationAllowed('cloud', definition.name, requestedCompletion),
    ),
  };

  let bodyFailed = false;
  let bodyFailure: unknown;
  try {
    await definition.body(context);
  } catch (error) {
    bodyFailed = true;
    bodyFailure = error;
  }
  if (bodyFailed) {
    await stopAuthoredOperations(authoredSteps, bodyFailure);
    throw bodyFailure;
  }
  await verifyAuthoredOperations(definition.name, authoredSteps);
  if (requestedCompletion === undefined) {
    throw new AuthoredFlowExecutionError(
      'missing_completion',
      `flow "${definition.name}" returned without done()`,
    );
  }

  await lowerDeterministic(`complete-${nextStep}`, ':');
  return Object.freeze({
    name: definition.name,
    completionReason: requestedCompletion,
    journalSteps: Object.freeze([...journalSteps]),
  });
}

function trackStep<T>(
  tracked: AuthoredFlowOperation<unknown>[],
  operation: AuthoredFlowOperation<T>,
): Step<T> {
  tracked.push(operation as AuthoredFlowOperation<unknown>);
  return operation.step;
}

function unsupportedStep<T>(
  id: string,
  verb: string,
  assertCanStart: () => void,
): AuthoredFlowOperation<T> {
  return new AuthoredFlowOperation<T>(id, verb, assertCanStart, async () => {
    throw unsupportedVerb(verb);
  });
}

function unsupportedVerb(verb: string): AuthoredFlowExecutionError {
  return new AuthoredFlowExecutionError(
    'unsupported_verb',
    `the initial authored executor does not lower f.${verb}`,
  );
}

function assertOperationAllowed(
  verb: string,
  flowName: string,
  completion: SurfaceRunCompletionReason | undefined,
): void {
  if (completion !== undefined) {
    throw new AuthoredFlowExecutionError(
      'operation_after_completion',
      `flow "${flowName}" called f.${verb} after done()`,
      completion,
    );
  }
}

function unsupportedCloud(assertOpen: () => void): CloudHelper {
  return new Proxy({}, {
    get() {
      assertOpen();
      throw unsupportedVerb('cloud');
    },
  }) as CloudHelper;
}

async function readSuccessfulOutput(
  journal: JournalClient,
  outcome: RunOutcome,
  stepId: string,
  journalSteps: AuthoredFlowJournalStep[],
): Promise<string> {
  const entries = (await journal.journalRead(outcome.run_id, 1)).entries;
  const completed = entries.find((entry) => isStepCompleted(entry, stepId));
  if (!isStepCompleted(completed, stepId)) {
    throw protocolViolation(outcome.run_id, `journal has no step.completed for "${stepId}"`);
  }

  const reason = completed.payload.completionReason;
  journalSteps.push(Object.freeze({ id: stepId, runId: outcome.run_id, completionReason: reason }));
  if (reason !== 'success') {
    throw new AuthoredFlowExecutionError(
      'step_failed',
      `journal step "${stepId}" completed with ${reason}`,
      reason,
      outcome.run_id,
    );
  }
  if (outcome.status !== 'completed' || outcome.completion_reason !== 'success') {
    throw protocolViolation(
      outcome.run_id,
      `successful step entry conflicts with run outcome ${outcome.status}/${String(outcome.completion_reason)}`,
    );
  }

  const output = completed.payload.output;
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

function isSurfaceCompletionReason(value: unknown): value is ProtocolCompletionReason {
  return typeof value === 'string'
    && (COMPLETION_REASONS as readonly string[]).includes(value);
}

function isSurfaceRunCompletionReason(value: unknown): value is ProtocolRunCompletionReason {
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
