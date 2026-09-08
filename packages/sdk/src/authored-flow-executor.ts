import {
  COMPLETION_REASONS,
  RUN_COMPLETION_REASONS,
  type AgentOptions,
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
import type { GetFlowDefinition } from './authored-flow-loader.js';
import { checkAuthoredFlow } from './cli/check.js';
import type { PreflightDiagnostic } from './preflight.js';
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
  RunOutcome,
} from './protocol.js';
import { SPEC_SCHEMA_VERSION, type FlowSpec } from './spec.js';

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
export interface ExecuteAuthoredFlowOptions {
  /**
   * Defaults to this package's own static import — correct for every
   * existing (internal, single-instance) caller. A flow loaded from an
   * external path via `loadAuthoredFlow` must pass ITS resolved
   * `getDefinition` instead; see authored-flow-loader.ts's comment on why.
   */
  readonly getDefinition?: GetFlowDefinition;
  /**
   * The flow file's own path, or a directory to search upward from — passed
   * straight to `checkAuthoredFlow` (cli/check.ts) so `f.agent` resolves a
   * CLI the same way a declarative `type: agent` step does: nearest
   * `flows.json`, real auth/model probing, canonicalized path. Defaults to
   * `process.cwd()`, matching what running `flows check` from a terminal
   * would search from.
   */
  readonly flowPath?: string;
}

export async function executeAuthoredFlow<Input = undefined>(
  handle: FlowHandle,
  journal: JournalClient,
  input?: Input,
  options: ExecuteAuthoredFlowOptions = {},
): Promise<AuthoredFlowExecutionResult> {
  const getDefinition = options.getDefinition ?? getAuthoredFlowDefinition;
  const flowPath = options.flowPath ?? process.cwd();
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

  // `name` (the first f.agent argument, e.g. "fixer") is not wired to the
  // kernel's `agent` field: that field selects a NAMED declaration from
  // `FlowSpec.agents`, and this executor refuses every non-empty header
  // (see the top of this function) — an authored flow has no way to declare
  // one today. `name` is kept only for step-id readability; CLI selection
  // goes through the project's flows.json default below, same as it does
  // for a bare `type: agent` YAML step with no explicit `cli`.
  //
  // `options.workspace` is passed through as a single opaque surface
  // identifier. The `"path/glob: readwrite"` permission-annotation shorthand
  // shown in docs/SURFACE.md and the examples is not implemented by any
  // parser anywhere in this package today — grepped for it before writing
  // this, found nothing — so this does not attempt to parse one out of the
  // string. A workspace string is declared, not yet permissioned.
  const lowerAgent = async (
    id: string,
    options: AgentOptions,
  ): Promise<AgentResult> => {
    const authoring: FlowSpec = {
      version: SPEC_SCHEMA_VERSION,
      name: `${definition.name}/${id}`,
      steps: [{
        id,
        type: 'agent',
        instruction: options.task,
        ...(options.workspace === undefined ? {} : {
          surfaces: { workspace: [{ surface: options.workspace }] },
        }),
      }],
    };
    // The kernel never resolves a `cli` on its own — every declarative
    // `flows run`/`flows check` binds it first via this exact function
    // (cli/check.ts), searching for the nearest flows.json from `flowPath`
    // and real-probing auth/model readiness. An authored agent step gets
    // nothing for free just because it was declared in TS instead of YAML.
    const { report, flow: resolved } = checkAuthoredFlow(authoring, flowPath);
    if (!report.ok || resolved === undefined) {
      const refusal = report.diagnostics.find(
        (diagnostic): diagnostic is PreflightDiagnostic & { severity: 'refusal' } =>
          diagnostic.severity === 'refusal',
      );
      throw new AuthoredFlowExecutionError(
        'agent_cli_unresolved',
        refusal?.message
          ?? `flow "${definition.name}" step "${id}": no CLI could be resolved for f.agent `
            + `(searched for flows.json from "${flowPath}")`,
      );
    }
    const spec = toKernelSpec(resolved);
    const outcome = await journal.runStart(spec);
    return readSuccessfulAgentOutput(journal, outcome, id, journalSteps);
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
        lifecycle,
      ));
    },
    llm() {
      assertOperationAllowed('llm', definition.name, requestedCompletion);
      const id = `llm-${nextStep++}`;
      return trackStep(authoredSteps, unsupportedStep(
        id,
        'llm',
        () => assertOperationAllowed('llm', definition.name, requestedCompletion),
        lifecycle,
      ));
    },
    agent(name, options) {
      assertOperationAllowed('agent', definition.name, requestedCompletion);
      void name; // step-id readability only — see the comment on lowerAgent.
      const id = `agent-${nextStep++}`;
      return trackStep(authoredSteps, new AuthoredFlowOperation(
        id,
        'agent',
        () => assertOperationAllowed('agent', definition.name, requestedCompletion),
        () => lowerAgent(id, options),
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

function unsupportedStep<T>(
  id: string,
  verb: string,
  assertCanStart: () => void,
  lifecycle: AuthoredFlowLifecycle,
): AuthoredFlowOperation<T> {
  return new AuthoredFlowOperation<T>(id, verb, assertCanStart, async () => {
    throw unsupportedVerb(verb);
  }, lifecycle);
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

/**
 * Shared by every `f.*` verb that lowers to one kernel step run in isolation:
 * find its `step.completed` entry, record it, and refuse anything but a
 * clean success before handing the raw `output` back for verb-specific
 * extraction (a plain string for `f.run`, an `AgentResult` for `f.agent`).
 */
async function readCompletedStepOutput(
  journal: JournalClient,
  outcome: RunOutcome,
  stepId: string,
  journalSteps: AuthoredFlowJournalStep[],
): Promise<unknown> {
  const { entry: completed, polled } = await waitForStepCompleted(journal, outcome.run_id, stepId);

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
  // `outcome` is `runStart`'s IMMEDIATE response. When the completed entry
  // was already there on the first read (`!polled`) — true for every
  // deterministic step, since the kernel drives those to completion inline
  // — `outcome` was already accurate and this repo's test suite (including a
  // mock journal server with no `run.get` handler) already depends on that.
  // Only when waitForStepCompleted genuinely had to poll (an agent step,
  // dispatched to an external worker asynchronously) is `outcome` provably
  // stale, and only then is it worth the extra round trip to re-check.
  if (polled) {
    const current = await journal.runGet(outcome.run_id);
    if (current.status !== 'completed') {
      throw protocolViolation(
        outcome.run_id,
        `successful step entry conflicts with current run status "${current.status}"`,
      );
    }
  } else if (outcome.status !== 'completed' || outcome.completion_reason !== 'success') {
    throw protocolViolation(
      outcome.run_id,
      `successful step entry conflicts with run outcome ${outcome.status}/${String(outcome.completion_reason)}`,
    );
  }
  return completed.payload.output;
}

async function readSuccessfulOutput(
  journal: JournalClient,
  outcome: RunOutcome,
  stepId: string,
  journalSteps: AuthoredFlowJournalStep[],
): Promise<string> {
  const output = await readCompletedStepOutput(journal, outcome, stepId, journalSteps);
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
async function readSuccessfulAgentOutput(
  journal: JournalClient,
  outcome: RunOutcome,
  stepId: string,
  journalSteps: AuthoredFlowJournalStep[],
): Promise<AgentResult> {
  const output = await readCompletedStepOutput(journal, outcome, stepId, journalSteps);
  if (!isRecord(output)) {
    throw protocolViolation(outcome.run_id, `step "${stepId}" produced a non-object output`);
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

/**
 * Polls until `stepId`'s `step.completed` journal entry appears. A
 * deterministic step is typically already there on the first read (the
 * kernel drives it inline); an agent step depends on an externally attached
 * worker actually running a real CLI process, which can take real wall-clock
 * time — a single immediate read raced this and lost the first time this was
 * tried against a live worker.
 */
interface StepCompletedWait {
  readonly entry: StepCompletedEntry;
  /** False iff the entry was already there on the very first read. */
  readonly polled: boolean;
}

async function waitForStepCompleted(
  journal: JournalClient,
  runId: string,
  stepId: string,
  timeoutMs = 30_000,
): Promise<StepCompletedWait> {
  const deadline = Date.now() + timeoutMs;
  let polled = false;
  while (true) {
    const entries = (await journal.journalRead(runId, 1)).entries;
    const completed = entries.find((entry) => isStepCompleted(entry, stepId));
    if (isStepCompleted(completed, stepId)) return { entry: completed, polled };
    if (Date.now() >= deadline) {
      throw protocolViolation(
        runId,
        `journal has no step.completed for "${stepId}" after ${timeoutMs}ms`,
      );
    }
    polled = true;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
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
