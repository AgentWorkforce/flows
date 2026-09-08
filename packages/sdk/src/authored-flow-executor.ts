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
import { join } from 'node:path';
import { compileSpec, toKernelSpec } from './compile.js';
import { getAuthoredFlowDefinition } from './authored-flow.js';
import type { GetFlowDefinition } from './authored-flow-loader.js';
import { checkAuthoredFlow } from './cli/check.js';
import { classifyOutcome, type RunLifecycleOptions } from './cli/run.js';
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

/**
 * Matches the `"path/glob: readonly"` / `"path/glob: readwrite"` shorthand
 * shown in docs/SURFACE.md and the examples — the only shape a workspace
 * string could plausibly declare a permission in. No parser anywhere in this
 * package turns that annotation into a real restriction, so `lowerAgent`
 * refuses rather than silently accepting and ignoring it.
 */
const WORKSPACE_PERMISSION_ANNOTATION = /:\s*(readonly|readwrite)\s*$/i;

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
}

export async function executeAuthoredFlow<Input = undefined>(
  handle: FlowHandle,
  journal: JournalClient,
  input?: Input,
  options: ExecuteAuthoredFlowOptions = {},
): Promise<AuthoredFlowExecutionResult> {
  const getDefinition = options.getDefinition ?? getAuthoredFlowDefinition;
  const flowPath = options.flowPath ?? join(process.cwd(), 'flow.ts');
  // Named separately from `options` because `lowerAgent` below has its own,
  // differently-typed `options: AgentOptions` parameter that shadows this one.
  const waitOptions: RunLifecycleOptions = {
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.onWait !== undefined ? { onWait: options.onWait } : {}),
  };
  const definition = getDefinition<Input>(handle);
  // `agents` is the one header field this executor lowers today (into
  // `FlowSpec.agents`, resolved by `lowerAgent` below exactly like the
  // declarative dialect's `agents:` map). Every other header field remains
  // unimplemented and refuses closed rather than being silently ignored.
  const unsupportedHeaderFields = Object.keys(definition.header)
    .filter((field) => field !== 'agents');
  if (unsupportedHeaderFields.length > 0) {
    throw new AuthoredFlowExecutionError(
      'unsupported_header',
      `flow "${definition.name}" uses unsupported header fields: ${unsupportedHeaderFields.join(', ')}`,
    );
  }
  // Every declared named agent's model must be checked BEFORE the body runs,
  // not lazily the first time a matching `f.agent` call happens to be
  // reached: the declarative dialect's own preflight (preflight.ts's
  // unknownModelDiagnostics) checks every entry in `flow.agents`, used or
  // not, before any step submits — an unregistered model on a header entry
  // the body never selects must refuse the same way, not silently pass. This
  // is header data available before the body starts (no need to predict
  // arbitrary TS control flow): a placeholder no-op deterministic step
  // carries the declared `agents` map through the same real preflight
  // `lowerAgent` uses, without probing any CLI (deterministic steps are
  // never CLI-resolved) and without journaling anything on success.
  if (definition.header.agents !== undefined && Object.keys(definition.header.agents).length > 0) {
    const { report } = checkAuthoredFlow({
      version: SPEC_SCHEMA_VERSION,
      name: `${definition.name}/declared-agents`,
      agents: { ...definition.header.agents },
      steps: [{ id: 'declared-agents', type: 'deterministic', command: ':' }],
    }, flowPath);
    if (!report.ok) {
      const refusal = report.diagnostics.find(
        (diagnostic): diagnostic is PreflightDiagnostic & { severity: 'refusal' } =>
          diagnostic.severity === 'refusal',
      );
      throw new AuthoredFlowExecutionError(
        'agent_cli_unresolved',
        refusal?.message
          ?? `flow "${definition.name}" declares an invalid named agent`,
        undefined,
        undefined,
        refusal?.kind ?? 'invalid_spec',
      );
    }
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

  // `name` (the first f.agent argument, e.g. "fixer") selects a NAMED
  // declaration from the flow header's `agents` map, exactly like the
  // declarative dialect's `agent: fixer` step field selects from a top-level
  // `agents:` map — but ONLY when `name` actually matches a declared entry.
  // `compile.ts`'s `resolveNamedAgent` throws `unknown named agent` for any
  // `step.agent` that doesn't resolve, so setting it unconditionally would
  // break every call that uses `name` purely for step-id readability (the
  // common case, and every pre-existing `f.agent` caller). When there's no
  // match, `agent` stays unset and CLI selection falls through to the
  // project's flows.json default below, same as a bare `type: agent` YAML
  // step with no explicit `cli`/`agent`. `options.cli`/`options.model`
  // always pass through as step-level overrides, which win over any named
  // declaration independent of whether `name` matched one.
  const lowerAgent = async (
    id: string,
    name: string,
    options: AgentOptions,
  ): Promise<AgentResult> => {
    if (options.workspace !== undefined && WORKSPACE_PERMISSION_ANNOTATION.test(options.workspace)) {
      throw new AuthoredFlowExecutionError(
        'unsupported_workspace_permission',
        `flow "${definition.name}" step "${id}": workspace "${options.workspace}" declares a `
          + 'permission annotation ("...: readonly" / "...: readwrite"), but nothing enforces it — '
          + 'no parser anywhere in this package turns that annotation into a real restriction '
          + '(kernel/DAEMON-LIFECYCLE.md\'s permission model is untouched by f.agent). '
          + 'Silently accepting and ignoring it would let a flow believe a restriction is in effect '
          + "when it is not. Declare a bare surface name (no trailing \": readonly\"/\": readwrite\") "
          + 'if you do not need enforcement, or use the declarative spec\'s `permissions` field, which is real.',
      );
    }
    const namedAgents = definition.header.agents;
    const matchesNamedAgent = namedAgents !== undefined && Object.hasOwn(namedAgents, name);
    const authoring: FlowSpec = {
      version: SPEC_SCHEMA_VERSION,
      name: `${definition.name}/${id}`,
      ...(namedAgents === undefined ? {} : { agents: { ...namedAgents } }),
      steps: [{
        id,
        type: 'agent',
        instruction: options.task,
        ...(matchesNamedAgent ? { agent: name } : {}),
        ...(options.cli === undefined ? {} : { cli: options.cli }),
        ...(options.model === undefined ? {} : { model: options.model }),
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
        undefined,
        undefined,
        refusal?.kind ?? 'invalid_spec',
      );
    }
    const spec = toKernelSpec(resolved);
    const outcome = await journal.runStart(spec);
    // Reuse the declarative CLI's own wait/classification (cli/run.ts) rather
    // than a hand-rolled poll: `step.completed` and the run's own terminal
    // state are appended as two SEPARATE actions (kernel/relayflowd-core/src/machine.rs
    // completion_actions vs complete_run_actions), so a naive read right
    // after runStart can race a real, valid completion — and a genuinely
    // long-running agent has no reason to be bounded by anything other than
    // its own worker's lease, which classifyOutcome already follows
    // (renewing as the lease renews, per docs/SURFACE.md §5's WAITING
    // [worker_lease] contract), never an unrelated fixed deadline.
    const execution = await classifyOutcome(journal, 'run', outcome, report, '', waitOptions);
    if (execution.exitCode === 3) {
      const parked = execution.report.parkedStep;
      throw new AuthoredFlowExecutionError(
        'agent_parked',
        execution.report.diagnostics.at(-1)?.message
          ?? `flow "${definition.name}" step "${id}" parked`
            + (parked !== undefined ? ` (${parked.type})` : '')
            + ': no worker is attached to run it.',
        undefined,
        outcome.run_id,
      );
    }
    if (execution.exitCode !== 0) {
      const reason = execution.report.completionReason;
      throw new AuthoredFlowExecutionError(
        'step_failed',
        execution.report.diagnostics.at(-1)?.message
          ?? `flow "${definition.name}" step "${id}" did not complete successfully `
            + `(status: ${execution.report.status ?? 'unknown'})`,
        isSurfaceCompletionReason(reason) ? reason : undefined,
        outcome.run_id,
      );
    }
    return readSuccessfulAgentOutput(journal, outcome.run_id, id, journalSteps);
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
      const id = `agent-${nextStep++}`;
      return trackStep(authoredSteps, new AuthoredFlowOperation(
        id,
        'agent',
        () => assertOperationAllowed('agent', definition.name, requestedCompletion),
        () => lowerAgent(id, name, options),
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

async function readSuccessfulOutput(
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
async function readSuccessfulAgentOutput(
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
