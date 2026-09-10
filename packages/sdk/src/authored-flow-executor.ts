import { authoredWorkerRunner } from './authored-worker-step.js';
import { readSuccessfulOutput, isSurfaceRunCompletionReason } from './authored-step-output.js';
import {
  type LlmOptions,
  type CloudHelper,
  type CompletionReason as SurfaceCompletionReason,
  type Ctx,
  type RunCompletionReason as SurfaceRunCompletionReason,
  type Step,
} from '@relayflows/surface';
import type { FlowHandle } from '@relayflows/surface/runtime';
import { join } from 'node:path';
import { observeStep, type ProgressEvent } from './progress.js';
import { compileSpec, toKernelSpec } from './compile.js';
import { getAuthoredFlowDefinition } from './authored-flow.js';
import type { GetFlowDefinition } from './authored-flow-loader.js';
import type { RunLifecycleOptions } from './cli/run.js';
import {
  AuthoredFlowExecutionError,
  type AuthoredFlowExecutionErrorCode,
} from './authored-flow-error.js';
import {
  AuthoredFlowOperation,
  stopAuthoredOperations,
  verifyAuthoredOperations,
} from './authored-flow-operation.js';
import { AuthoredFlowLifecycle } from './authored-flow-lifecycle.js';
import { JournalClient } from './journal-client.js';
import type {
  CompletionReason as ProtocolCompletionReason,
  RunCompletionReason as ProtocolRunCompletionReason,
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
 * empty-header flow may await `f.run`, `f.llm`, and `f.agent` steps and must
 * finish with `f.done("success")`. Each step and the terminal marker is
 * a compiled spec submitted through
 * `JournalClient`; values are read back from `step.completed` journal entries.
 * Unsupported headers, verbs, gates, or completion lowering fail closed.
 */
export interface ExecuteAuthoredFlowOptions {
  /**
   * Defaults to this package's own static import — correct for every
   * existing (internal, single-instance) caller. A flow loaded from an
   * external path via `loadAuthoredFlow` must pass ITS resolved
   * `getDefinition` instead; see authored-flow-loader.ts's comment on why.
   */
  readonly getDefinition?: GetFlowDefinition;
  /**
   * The flow file's own path — passed straight to `checkAuthoredFlow`
   * (cli/check.ts) so `f.agent` resolves a CLI the same way a declarative
   * `type: agent` step does: nearest `flows.json`, real auth/model probing,
   * canonicalized path. `checkAuthoredFlow` always does `dirname()` on this,
   * matching `checkFlow`'s real `flows check <file>` contract — pass a FILE
   * path, not a directory, or the search starts one level too high. Defaults
   * to a synthetic `flow.ts` under `process.cwd()` for exactly this reason:
   * `process.cwd()` itself is a directory, and `dirname(process.cwd())`
   * would search cwd's PARENT.
   */
  readonly flowPath?: string;
  /** Passed straight through to classifyOutcome (cli/run.ts) for f.agent's wait. */
  readonly signal?: RunLifecycleOptions['signal'];
  readonly onWait?: RunLifecycleOptions['onWait'];
  readonly onProgress?: (event: ProgressEvent) => void;
  readonly localAgentStream?: string;
}

export async function executeAuthoredFlow<Input = undefined>(
  handle: FlowHandle,
  journal: JournalClient,
  input?: Input,
  options: ExecuteAuthoredFlowOptions = {},
): Promise<AuthoredFlowExecutionResult> {
  const getDefinition = options.getDefinition ?? getAuthoredFlowDefinition;
  const localAgentStream = options.localAgentStream;
  const onProgress = options.onProgress;
  const flowPath = options.flowPath ?? join(process.cwd(), 'flow.ts');
  const waitOptions: RunLifecycleOptions = {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.onWait !== undefined ? { onWait: options.onWait } : {}),
  };
  const definition = getDefinition<Input>(handle);
  const headerFields = Object.keys(definition.header);
  if (headerFields.length > 0) {
    throw new AuthoredFlowExecutionError(
      'unsupported_header',
      `flow "${definition.name}" uses unsupported header fields: ${headerFields.join(', ')}`,
    );
  }

  const journalSteps: AuthoredFlowJournalStep[] = [];
  const authoredSteps: AuthoredFlowOperation<unknown>[] = [];
  const lifecycle = new AuthoredFlowLifecycle();
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

  const worker = authoredWorkerRunner(definition, journal, flowPath, journalSteps, waitOptions, localAgentStream);

  function llmOperation(strings: TemplateStringsArray, ...values: unknown[]): Step<string>;
  function llmOperation(prompt: string, options: LlmOptions): Step<unknown>;
  function llmOperation(prompt: string | TemplateStringsArray, ...values: unknown[]): Step<unknown> {
    assertOperationAllowed('llm', definition.name, requestedCompletion);
    const id = `llm-${nextStep++}`;
    return trackStep(authoredSteps, new AuthoredFlowOperation(
      id, 'llm',
      () => assertOperationAllowed('llm', definition.name, requestedCompletion),
      () => observeStep(id, 'llm', () => {
        if (typeof prompt === 'string') {
          if (values.length !== 1 || values[0] === undefined) {
            throw new AuthoredFlowExecutionError('llm_cli_unresolved', 'f.llm(prompt, options) requires an output JSON Schema.');
          }
          return worker.llm(id, prompt, values[0] as LlmOptions);
        }
        const text = prompt.reduce((result, part, index) => result + part
          + (index < values.length ? String(values[index]) : ''), '');
        return worker.llm(id, text);
      }, onProgress),
      lifecycle,
    ));
  }

  const context: Ctx = {
    run(command) {
      assertOperationAllowed('run', definition.name, requestedCompletion);
      const id = `run-${nextStep++}`;
      return trackStep(authoredSteps, new AuthoredFlowOperation(
        id,
        'run',
        () => assertOperationAllowed('run', definition.name, requestedCompletion),
        () => observeStep(id, 'deterministic', () => lowerDeterministic(id, command), options.onProgress),
        lifecycle,
      ));
    },
    llm: llmOperation,
    agent(name, options) {
      assertOperationAllowed('agent', definition.name, requestedCompletion);
      void name; // Authored headers do not yet declare reusable named agents.
      const id = `agent-${nextStep++}`;
      return trackStep(authoredSteps, new AuthoredFlowOperation(
        id,
        'agent',
        () => assertOperationAllowed('agent', definition.name, requestedCompletion),
        () => observeStep(id, 'agent', () => worker.agent(id, options), onProgress),
        lifecycle,
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
      lifecycle.markCompletion();
      requestedCompletion = reason;
    },
    cloud: unsupportedCloud(
      () => assertOperationAllowed('cloud', definition.name, requestedCompletion),
    ),
  };

  let bodyFailed = false;
  let bodyFailure: unknown;
  try {
    const bodyPromise = lifecycle.runBody(() => definition.body(context, input as Input));
    await bodyPromise;
  } catch (error) {
    bodyFailed = true;
    bodyFailure = error;
  }
  if (bodyFailed) {
    try {
      await stopAuthoredOperations(authoredSteps, bodyFailure);
    } finally {
      lifecycle.close();
    }
    throw bodyFailure;
  }
  // The completion requirement is checked BEFORE operation verification,
  // because without a completion the verification cannot answer its own
  // question. `AuthoredFlowLifecycle.isHandled` decides whether an operation
  // was consumed by asking whether the COMPLETION depends on it; with no
  // completion there is no async id to trace from, so it returns false for
  // every operation. Verifying first therefore reported correctly-awaited
  // steps as `unawaited_step`, naming the step the author had awaited and
  // saying nothing about the `done()` they forgot (#183).
  //
  // A body that both forgets `done()` and leaves a step unawaited now reports
  // the missing completion. That is the honest order: the unawaited-step
  // verdict is not computable until there is a completion to compute it
  // against, and once the author adds `done()` the verification runs normally
  // and will catch it.
  if (requestedCompletion === undefined) {
    const missingCompletion = new AuthoredFlowExecutionError(
      'missing_completion',
      `flow "${definition.name}" returned without done()`,
    );
    try {
      await stopAuthoredOperations(authoredSteps, missingCompletion);
    } finally {
      lifecycle.close();
    }
    throw missingCompletion;
  }
  try {
    await verifyAuthoredOperations(definition.name, authoredSteps, lifecycle);
  } finally {
    lifecycle.close();
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
