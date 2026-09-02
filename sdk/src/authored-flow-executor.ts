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

export type AuthoredFlowExecutionErrorCode =
  | 'duplicate_completion'
  | 'journal_protocol_violation'
  | 'missing_completion'
  | 'operation_after_completion'
  | 'step_failed'
  | 'unsupported_completion'
  | 'unsupported_gate'
  | 'unsupported_header'
  | 'unawaited_step'
  | 'unsupported_verb';

export class AuthoredFlowExecutionError extends Error {
  constructor(
    readonly code: AuthoredFlowExecutionErrorCode,
    message: string,
    readonly completionReason?: ProtocolCompletionReason | ProtocolRunCompletionReason,
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
  const authoredSteps: TrackedThenable[] = [];
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
      return trackStep(
        authoredSteps,
        new DeferredJournalStep(id, 'run', () => lowerDeterministic(id, command)),
      );
    },
    llm() {
      assertOperationAllowed('llm', definition.name, requestedCompletion);
      const id = `llm-${nextStep++}`;
      return trackStep(authoredSteps, unsupportedStep(id, 'llm'));
    },
    agent() {
      assertOperationAllowed('agent', definition.name, requestedCompletion);
      const id = `agent-${nextStep++}`;
      return trackStep(authoredSteps, unsupportedStep<AgentResult>(id, 'agent'));
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

  await definition.body(context, input as Input);
  await refuseUnawaitedSteps(definition.name, authoredSteps);
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

interface TrackedThenable {
  readonly id: string;
  readonly verb: string;
  readonly consumed: boolean;
  readonly settled: boolean;
  waitForSettlement(): Promise<void>;
}

class DeferredJournalStep<T> implements Step<T>, TrackedThenable {
  private execution: Promise<T> | undefined;
  consumed = false;
  settled = false;

  constructor(
    readonly id: string,
    readonly verb: string,
    private readonly start: () => Promise<T>,
  ) {}

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
    this.consumed = true;
    this.execution ??= this.start().then(
      (value) => {
        this.settled = true;
        return value;
      },
      (error: unknown) => {
        this.settled = true;
        throw error;
      },
    );
    return this.execution.then(onfulfilled, onrejected);
  }

  async waitForSettlement(): Promise<void> {
    if (this.execution === undefined) return;
    await this.execution.then(() => undefined, () => undefined);
  }
}

function trackStep<T>(
  tracked: TrackedThenable[],
  step: DeferredJournalStep<T>,
): DeferredJournalStep<T> {
  tracked.push(step);
  return step;
}

function unsupportedStep<T>(id: string, verb: string): DeferredJournalStep<T> {
  return new DeferredJournalStep(id, verb, async () => {
    throw unsupportedVerb(verb);
  });
}

async function refuseUnawaitedSteps(
  flowName: string,
  steps: TrackedThenable[],
): Promise<void> {
  const unconsumed = steps.filter((step) => !step.consumed);
  if (unconsumed.length > 0) {
    throw new AuthoredFlowExecutionError(
      'unawaited_step',
      `flow "${flowName}" returned with unawaited steps: ${formatSteps(unconsumed)}`,
    );
  }

  const unsettled = steps.filter((step) => !step.settled);
  if (unsettled.length > 0) {
    await Promise.all(unsettled.map((step) => step.waitForSettlement()));
    throw new AuthoredFlowExecutionError(
      'unawaited_step',
      `flow "${flowName}" returned before steps settled: ${formatSteps(unsettled)}`,
    );
  }
}

function formatSteps(steps: TrackedThenable[]): string {
  return steps.map((step) => `${step.id} (f.${step.verb})`).join(', ');
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
