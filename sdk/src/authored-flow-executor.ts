import {
  COMPLETION_REASONS,
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

export type AuthoredFlowExecutionErrorCode =
  | 'duplicate_completion'
  | 'journal_protocol_violation'
  | 'missing_completion'
  | 'step_failed'
  | 'unsupported_completion'
  | 'unsupported_gate'
  | 'unsupported_header'
  | 'unsupported_verb';

export class AuthoredFlowExecutionError extends Error {
  constructor(
    readonly code: AuthoredFlowExecutionErrorCode,
    message: string,
    readonly completionReason?: ProtocolCompletionReason,
    readonly runId?: string,
  ) {
    super(`${code}: ${message}`);
    this.name = 'AuthoredFlowExecutionError';
  }
}

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

/**
 * Execute the currently supported authored-flow slice through protocol v0.
 *
 * The slice is deliberately narrow: an empty-header flow may await plain
 * `f.run(...)` steps and must finish with `f.done("success")`. Every run and
 * the terminal marker is a compiled deterministic spec submitted through
 * `JournalClient`; values are read back from `step.completed` journal entries.
 * Unsupported headers, verbs, gates, or completion lowering fail closed.
 */
export async function executeAuthoredFlow<Input = undefined>(
  handle: FlowHandle,
  journal: JournalClient,
  input?: Input,
): Promise<AuthoredFlowExecutionResult> {
  const definition = getAuthoredFlowDefinition<Input>(handle);
  const headerFields = Object.keys(definition.header);
  if (headerFields.length > 0) {
    throw new AuthoredFlowExecutionError(
      'unsupported_header',
      `flow "${definition.name}" uses unsupported header fields: ${headerFields.join(', ')}`,
    );
  }

  const journalSteps: AuthoredFlowJournalStep[] = [];
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
      const id = `run-${nextStep++}`;
      return new DeferredJournalStep(() => lowerDeterministic(id, command));
    },
    llm() {
      return unsupportedStep('llm');
    },
    agent() {
      return unsupportedStep<AgentResult>('agent');
    },
    async human() {
      throw unsupportedVerb('human');
    },
    async dispatch<T>() {
      throw unsupportedVerb('dispatch');
    },
    done(reason) {
      if (!isSurfaceCompletionReason(reason)) {
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
    cloud: unsupportedCloud(),
  };

  await definition.body(context, input as Input);
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

class DeferredJournalStep<T> implements Step<T> {
  private execution: Promise<T> | undefined;

  constructor(private readonly start: () => Promise<T>) {}

  gate(_predicate: (value: T) => boolean, _because?: string): Step<T> {
    throw new AuthoredFlowExecutionError(
      'unsupported_gate',
      'postfix gates are not lowered by the initial authored executor',
    );
  }

  then<TResult1 = T, TResult2 = never>(
    onfulfilled?: ((value: T) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): PromiseLike<TResult1 | TResult2> {
    this.execution ??= this.start();
    return this.execution.then(onfulfilled, onrejected);
  }
}

function unsupportedStep<T>(verb: string): Step<T> {
  return new DeferredJournalStep(async () => {
    throw unsupportedVerb(verb);
  });
}

function unsupportedVerb(verb: string): AuthoredFlowExecutionError {
  return new AuthoredFlowExecutionError(
    'unsupported_verb',
    `the initial authored executor does not lower f.${verb}`,
  );
}

function unsupportedCloud(): CloudHelper {
  return new Proxy({}, {
    get() {
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
