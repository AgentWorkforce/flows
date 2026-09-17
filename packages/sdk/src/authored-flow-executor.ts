import { assertAuthoredPromiseHooks } from './authored-runtime-capability.js';
import { pluginHelpers } from './plugin-loader.js';
import { runPluginEffect } from './authored-plugin-effect.js';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { runHelperEffect } from './authored-helper-effect.js';
import { checkSlackHelpers } from './slack-preflight.js';
import { snapshotJsonValue } from './json-value.js';
import type { SlackCall } from './slack-writeback.js';
import { checkMcpHeader, McpPreflightError } from './cli/check-typescript.js';
import { buildMcpProxy, runMcpEffect } from './authored-mcp.js';
import { AuthoredBudget } from './authored-budget.js';
import { assertMemoryReachable, authoredMemory, scriptMemoryScope } from './authored-memory.js';
import { authoredDeterministicRunner, authoredWorkerRunner } from './authored-worker-step.js';
import { isSurfaceFlowCompletionReason, isSurfaceRunCompletionReason } from './authored-step-output.js';
import {
  type AgentResult,
  type LlmOptions,
  type CloudHelper,
  type CompletionReason as SurfaceCompletionReason,
  type Ctx,
  type FlowCompletionReason,
  type RunCompletionReason as SurfaceRunCompletionReason,
  type Step,
} from '@relayflows/surface';
import { createHelpers, helperProviders, type HelperCall, type FlowHandle } from '@relayflows/surface/runtime';
import { join } from 'node:path';
import { observeStep, type ProgressEvent } from './progress.js';
import { parseStepTimeout } from './compile.js';
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
type DoneAcceptsOnlyFlowCompletionReasons = Assert<
  Equal<DoneCompletionReason, FlowCompletionReason>
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

export interface AuthoredExecutionRuntime {
  readonly kind: 'node';
  readonly version: string;
  readonly executableSha256: string;
  readonly payloadSha256: string;
}

export interface AuthoredFlowExecutionResult {
  readonly executionRuntime?: AuthoredExecutionRuntime;
  readonly rootRunId?: string;
  readonly name: string;
  readonly completionReason: LoweredCompletionReason;
  readonly journalSteps: readonly AuthoredFlowJournalStep[];
}

// The authoring SURFACE stays wide: `done()` accepts every
// `FlowCompletionReason` and refuses the kernel-owned ones at runtime with a
// diagnostic that names the alternative. The RESULT is narrow, because `done()`
// cannot store a reason this executor does not lower.
//
// Pinning the narrow type here is load-bearing, not cosmetic. Every reader of
// this result — the CLI report, the durable root, the IPC verifier — would
// otherwise have to re-derive "can this really be `canceled`?" and answer it
// by hand. Those hand-written answers disagreeing is the exact defect this
// change exists to close; a widening here re-opens it at compile time instead.
type ExecutionResultUsesLoweredCompletionReason = Assert<
  Equal<AuthoredFlowExecutionResult['completionReason'], LoweredCompletionReason>
>;
type JournalStepUsesStepCompletionReason = Assert<
  Equal<AuthoredFlowJournalStep['completionReason'], ProtocolCompletionReason>
>;

/**
 * Exercise the internal authored-flow lowering seam through protocol v0.
 *
 * This is deliberately not exported by the SDK package: without a durable
 * authored root, it is not a resumable public runner. The seam is narrow: an
 * flow with an optional budget may await `f.run`, `f.llm`, and `f.agent` steps and must
 * finish with one of the lowered completions — `f.done("success")`,
 * `f.done("needs_human")`, `f.done("step_failed")` or `f.done("declined")`. Each step and the terminal marker is
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
  /** Helper receipt and mock-writeback storage; CLI passes its daemon data directory. */
  readonly dataDir?: string;
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
  /** Durable kernel root that owns this body's child admission identities. */
  readonly rootRunId?: string;
}

export async function executeAuthoredFlow<Input = undefined>(
  handle: FlowHandle,
  journal: JournalClient,
  input?: Input,
  options: ExecuteAuthoredFlowOptions = {},
): Promise<AuthoredFlowExecutionResult> {
  assertAuthoredPromiseHooks();
  const getDefinition = options.getDefinition ?? getAuthoredFlowDefinition;
  const localAgentStream = options.localAgentStream;
  const onProgress = options.onProgress;
  const flowPath = options.flowPath ?? join(process.cwd(), 'flow.ts');
  const waitOptions: RunLifecycleOptions = {
    // Carried so a failed `f.agent` can name the journal that holds its
    // evidence. Each authored worker call runs as its own kernel run, and
    // without the data dir the diagnostic can name the run id but not where
    // on disk to read it.
    ...(options.dataDir !== undefined ? { dataDir: options.dataDir } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
    ...(options.onWait !== undefined ? { onWait: options.onWait } : {}),
  };
  const definition = getDefinition<Input>(handle);
  const headerFields = Object.keys(definition.header).filter(key => key !== 'tools' && key !== 'budget' && key !== 'memory');
  if (definition.header.tools && Object.keys(definition.header.tools).some(key => !['mcp', ...helperProviders.map(p => p.namespace)].includes(key))) headerFields.push('tools');
  if (definition.header.tools?.relayfile !== undefined) headerFields.push('tools.relayfile');
  const helperPreflight = checkSlackHelpers(definition);
  if (!helperPreflight.ok) {
    const diagnostic = helperPreflight.diagnostics[0]!;
    throw new AuthoredFlowExecutionError(diagnostic.kind as AuthoredFlowExecutionErrorCode, diagnostic.message);
  }
  if (headerFields.length > 0) {
    throw new AuthoredFlowExecutionError(
      'unsupported_header',
      `flow "${definition.name}" uses unsupported header fields: ${headerFields.join(', ')}`,
    );
  }

  const checkedMcp = await checkMcpHeader(definition, flowPath);
  if (!checkedMcp.report.ok) throw new McpPreflightError(checkedMcp.report);

  const budget = new AuthoredBudget(definition.header.budget);
  if (definition.header.memory?.agent === true) {
    throw new AuthoredFlowExecutionError('unsupported_header', 'memory.agent requires the follow-up identity-scoped agent memory adapter');
  }
  // Direct member use is checked before any body effects; aliases are checked
  // by the helper itself, without executing the body during discovery.
  if (definition.header.memory !== undefined || /\.memory\b/.test(String(definition.body))) {
    await assertMemoryReachable();
  }

  const journalSteps: AuthoredFlowJournalStep[] = [];
  const authoredSteps: AuthoredFlowOperation<unknown>[] = [];
  const lifecycle = new AuthoredFlowLifecycle();
  let nextStep = 1;
  let requestedCompletion: LoweredCompletionReason | undefined;

  const lowerDeterministic = authoredDeterministicRunner(
    definition.name, journal, journalSteps, budget, options.rootRunId,
  );

  const worker = authoredWorkerRunner(
    definition, journal, flowPath, journalSteps, waitOptions,
    localAgentStream, budget, definition.header.budget, options.rootRunId,
  );

  /**
   * Predicate gates (docs/SURFACE.md §6). The closure runs here, once, on the
   * value the journal handed back; the VERDICT is then journaled as a lowered
   * `<id>.gate` deterministic step that succeeds or fails, so a resume or
   * replay reads the recorded verdict and never re-runs author code. A false
   * verdict fails the step as `gate_failed`, carrying the author's reason.
   *
   * Durability across a resume: the verdict is appended to the root run's
   * `predicate-gates` stream BEFORE the gate run is opened. A resumed body
   * re-executes and reaches the same gate; it finds the recorded verdict and
   * reuses it, so the gate run's spec (which embeds the verdict) is identical
   * under its admission key and the closure is never re-run. Without a root
   * run there is nothing to resume, and the closure simply runs.
   */
  const PREDICATE_STREAM = 'predicate-gates';
  interface PredicateRecord { gate: 'predicate'; step: string; verdict: 'pass' | 'fail'; because?: string; threw?: string }
  // The stream is read once per execution; concurrent gates (Promise.all)
  // share the single in-flight load, so none of them can observe an empty
  // map while the read is still pending and re-run a closure whose verdict
  // was already recorded.
  let recordedVerdicts: Promise<Map<string, PredicateRecord>> | undefined;
  async function loadRecordedVerdicts(rootRunId: string): Promise<Map<string, PredicateRecord>> {
    const verdicts = new Map<string, PredicateRecord>();
    let offset = 0;
    for (;;) {
      const page = await journal.streamRead(rootRunId, PREDICATE_STREAM, offset, 1000);
      for (const message of page.messages) {
        const record = (message as { message?: unknown }).message ?? message;
        if (typeof record === 'object' && record !== null && (record as PredicateRecord).gate === 'predicate'
          && typeof (record as PredicateRecord).step === 'string'
          && ((record as PredicateRecord).verdict === 'pass' || (record as PredicateRecord).verdict === 'fail')) {
          verdicts.set((record as PredicateRecord).step, record as PredicateRecord);
        }
      }
      if (page.messages.length === 0 || page.next_offset <= offset) break;
      offset = page.next_offset;
    }
    return verdicts;
  }
  async function recordedVerdict(id: string): Promise<PredicateRecord | undefined> {
    if (options.rootRunId === undefined) return undefined;
    recordedVerdicts ??= loadRecordedVerdicts(options.rootRunId);
    return (await recordedVerdicts).get(id);
  }
  async function applyPredicateGate<T>(operation: { id: string; predicateGate: unknown }, value: T): Promise<T> {
    const gate = operation.predicateGate as { predicate: (value: T) => boolean; because?: string } | undefined;
    if (gate === undefined) return value;
    const id = operation.id;
    let record = await recordedVerdict(id);
    if (record === undefined) {
      let verdict: boolean;
      let detail: string | undefined;
      try {
        verdict = gate.predicate(value) === true;
      } catch (error) {
        verdict = false;
        detail = error instanceof Error ? error.message : String(error);
      }
      record = {
        gate: 'predicate', step: id, verdict: verdict ? 'pass' : 'fail',
        ...(gate.because === undefined ? {} : { because: gate.because }),
        ...(detail === undefined ? {} : { threw: detail }),
      };
      if (options.rootRunId !== undefined) {
        await journal.streamAppend(options.rootRunId, PREDICATE_STREAM, record);
        (await recordedVerdicts)?.set(id, record);
      }
    }
    const literal = `'${JSON.stringify(record).replaceAll("'", "'\\''")}'`;
    const command = record.verdict === 'pass' ? `printf '%s' ${literal}` : `printf '%s' ${literal} >&2; exit 1`;
    try {
      await observeStep(`${id}.gate`, 'deterministic', () => lowerDeterministic(`${id}.gate`, command, false), options.onProgress);
    } catch (error) {
      if (record.verdict === 'pass') throw error;
      throw new AuthoredFlowExecutionError(
        'gate_failed',
        `step "${id}" failed its predicate gate`
          + (record.because === undefined ? '' : `: ${record.because}`)
          + (record.threw === undefined ? '' : ` (predicate threw: ${record.threw})`),
        'verification_failed',
        error instanceof AuthoredFlowExecutionError ? error.runId : undefined,
      );
    }
    return value;
  }
  lifecycle.applyPredicateGate = applyPredicateGate;

  function llmOperation(strings: TemplateStringsArray, ...values: unknown[]): Step<string>;
  function llmOperation(prompt: string, options: LlmOptions): Step<unknown>;
  function llmOperation(prompt: string | TemplateStringsArray, ...values: unknown[]): Step<unknown> {
    assertOperationAllowed('llm', definition.name, requestedCompletion);
    const id = `llm-${nextStep++}`;
    // Hoist the operation reference so the start closure can read the
    // caller's `.gate(config)` at spec-build time. AuthoredFlowOperation
    // begins after construction returns, so `llmOp` is defined by then.
    let llmOp!: AuthoredFlowOperation<unknown>;
    llmOp = new AuthoredFlowOperation(
      id, 'llm',
      () => assertOperationAllowed('llm', definition.name, requestedCompletion),
      () => observeStep(id, 'llm', () => {
        if (typeof prompt === 'string') {
          if (values.length !== 1 || values[0] === undefined) {
            throw new AuthoredFlowExecutionError('llm_cli_unresolved', 'f.llm(prompt, options) requires an output JSON Schema.');
          }
          return worker.llm(id, prompt, values[0] as LlmOptions, llmOp.namedGate);
        }
        const text = prompt.reduce((result, part, index) => result + part
          + (index < values.length ? String(values[index]) : ''), '');
        return worker.llm(id, text, undefined, llmOp.namedGate);
      }, onProgress),
      lifecycle,
    );
    return trackStep(authoredSteps, llmOp);
  }

  const slackRun = options.rootRunId ?? randomUUID();
  function slackOperation<T>(call: SlackCall): Step<T> {
    assertOperationAllowed(`slack.${call.verb}`, definition.name, requestedCompletion);
    const snapshot = snapshotJsonValue(call, 'f.slack call') as unknown as SlackCall;
    const id = `slack-${slackRun}-${nextStep++}`;
    return trackStep(authoredSteps, new AuthoredFlowOperation<T>(
      id, `slack.${call.verb}`,
      () => assertOperationAllowed(`slack.${call.verb}`, definition.name, requestedCompletion),
      async () => {
        const receipt = await runHelperEffect(journal, definition.name, id, snapshot,
          options.dataDir ?? dirname(journal.socketPath), journalSteps, options.rootRunId);
        return (call.verb === 'react' ? undefined : receipt) as T;
      },
      lifecycle,
    ));
  }

  const context: Ctx = {
    ...createHelpers(<T>(call: HelperCall): Step<T> => {
      const verb = `${call.provider}.${call.verb}`;
      assertOperationAllowed(verb, definition.name, requestedCompletion);
      const snapshot = snapshotJsonValue(call, `f.${verb} call`) as unknown as HelperCall;
      const id = `${call.provider}-${slackRun}-${nextStep++}`;
      return trackStep(authoredSteps, new AuthoredFlowOperation<T>(id, verb,
        () => assertOperationAllowed(verb, definition.name, requestedCompletion),
        async () => await runHelperEffect(journal, definition.name, id, snapshot,
          options.dataDir ?? dirname(journal.socketPath), journalSteps, options.rootRunId) as T,
        lifecycle));
    }),
    slack: {
      post: (channel, text, opts) => slackOperation({ type: 'effect', provider: 'slack', verb: 'post', params: { channel, text, ...(opts === undefined ? {} : { opts }) } }),
      dm: (user, text) => slackOperation({ type: 'effect', provider: 'slack', verb: 'dm', params: { user, text } }),
      reply: (channel, threadTs, text) => slackOperation({ type: 'effect', provider: 'slack', verb: 'reply', params: { channel, threadTs, text } }),
      react: (channel, messageTs, emoji) => slackOperation({ type: 'effect', provider: 'slack', verb: 'react', params: { channel, messageTs, emoji } }),
    },
    mcp: buildMcpProxy(checkedMcp.inventory, (server, tool, args, known) => {
      assertOperationAllowed('mcp', definition.name, requestedCompletion);
      const id = `mcp-${nextStep++}`;
      return trackStep(authoredSteps, new AuthoredFlowOperation(
        id, 'mcp',
        () => assertOperationAllowed('mcp', definition.name, requestedCompletion),
        () => runMcpEffect(journal, definition.name, id, server, tool, args,
          known, checkedMcp.servers[server]!, journalSteps, options.rootRunId),
        lifecycle,
      ));
    }),
    memory: authoredMemory(
      scriptMemoryScope(flowPath, definition.name),
      () => assertOperationAllowed('memory', definition.name, requestedCompletion),
      definition.header.memory?.script !== false,
    ),
    run(command, runOptions) {
      assertOperationAllowed('run', definition.name, requestedCompletion);
      const leaseMs = runOptions?.timeout === undefined ? undefined : parseStepTimeout(runOptions.timeout);
      const id = `run-${nextStep++}`;
      let runOp!: AuthoredFlowOperation<string>;
      runOp = new AuthoredFlowOperation<string>(
        id,
        'run',
        () => assertOperationAllowed('run', definition.name, requestedCompletion),
        () => observeStep(id, 'deterministic', () => lowerDeterministic(id, command, false, leaseMs, runOp.namedGate), options.onProgress),
        lifecycle,
      );
      return trackStep(authoredSteps, runOp);
    },
    llm: llmOperation,
    agent(name, options) {
      assertOperationAllowed('agent', definition.name, requestedCompletion);
      void name; // Authored headers do not yet declare reusable named agents.
      const id = `agent-${nextStep++}`;
      let agentOp!: AuthoredFlowOperation<AgentResult>;
      agentOp = new AuthoredFlowOperation<AgentResult>(
        id,
        'agent',
        () => assertOperationAllowed('agent', definition.name, requestedCompletion),
        () => observeStep(id, 'agent', () => worker.agent(id, options, agentOp.namedGate), onProgress),
        lifecycle,
      );
      return trackStep(authoredSteps, agentOp);
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
      if (!isSurfaceFlowCompletionReason(reason)) {
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
      // `step_failed` is a verdict about the flow's OWN work — "the checks I
      // ran did not pass" — and an authored body is authoritative about that.
      // `canceled` and `budget_exceeded` are control-plane facts the kernel
      // owns: cancellation arrives through `run.cancel`, budget exhaustion
      // through the enforced budget (authored-budget.ts). A body that declared
      // either would be asserting a kernel fact that never happened, so they
      // stay refused — with a reason, not with "this executor cannot yet".
      // `canceled` has no terminal shape to lower into either: there is no
      // `cancelled` RunStatus in the local protocol, and Cloud accepts that
      // completionReason only under a `cancelled` status this CLI never reports.
      if (!isLoweredCompletion(reason)) {
        throw new AuthoredFlowExecutionError(
          'unsupported_completion',
          `done("${reason}") is a kernel outcome, not an authored verdict: the kernel `
            + 'records it when it cancels a run or exhausts its budget, so a flow body '
            + 'cannot declare it. Use done("step_failed") to declare that the flow\'s own '
            + 'checks did not pass, or done("declined") to deliberately choose not to act.',
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

  Object.assign(context, pluginHelpers(checkedMcp.plugins ?? [], (plugin, verb, args) => {
    const label = `${verb.namespace}.${verb.method}`;
    assertOperationAllowed(label, definition.name, requestedCompletion);
    const id = `plugin-${nextStep++}`;
    return trackStep(authoredSteps, new AuthoredFlowOperation(
      id, label, () => assertOperationAllowed(label, definition.name, requestedCompletion),
      () => runPluginEffect(journal, definition.name, id, plugin, verb, args,
        journalSteps, budget, options.rootRunId),
      lifecycle,
    ));
  }));

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

  // Record the authored verdict as a SUCCESSFUL effect carrying that verdict,
  // not as a fabricated kernel run.completed reason. The marker step reports
  // what the body decided; it is not itself a step that failed. The CLI turns
  // the verdict into the exit code (success/declined 0, needs_human 3, step_failed 1).
  await lowerDeterministic(`complete-${nextStep}`,
    completionMarker(requestedCompletion), true);
  return Object.freeze({
    ...(options.rootRunId === undefined ? {} : { rootRunId: options.rootRunId }),
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

/**
 * The completion reasons an authored body may declare and this executor lowers.
 *
 * `FlowCompletionReason` is wider than this on purpose — it is the journal's
 * run vocabulary plus authored verdicts — but the two sets drifting silently is
 * exactly what made a type-valid `done("step_failed")` die at runtime as
 * `unsupported_completion`. Every gate that asks "is this a completion this
 * runtime can lower?" now asks this one function, so a reason cannot be
 * accepted in one place and rejected in another.
 *
 * These three are internal cross-module helpers for the authored seam (the
 * executor, the durable root, the IPC verifier and the CLI report), NOT public
 * SDK surface. `src/index.ts` deliberately re-exports nothing from this module
 * — keep it that way, or the whole authored seam leaks with them.
 */
export const LOWERED_COMPLETIONS = ['success', 'needs_human', 'step_failed', 'declined'] as const;
export type LoweredCompletionReason = (typeof LOWERED_COMPLETIONS)[number];

export function isLoweredCompletion(value: unknown): value is LoweredCompletionReason {
  return typeof value === 'string' && (LOWERED_COMPLETIONS as readonly string[]).includes(value);
}

/**
 * The deterministic command that carries an authored verdict into the journal.
 *
 * `success` lowers to `:` because success needs no marker: the marker run's own
 * kernel `success` already IS that record. Every other lowered verdict is
 * something the kernel's completion vocabulary cannot express on a step that
 * *succeeded*, so it travels as data on stdout and is read back from
 * `step.completed`. It is deliberately not lowered as a failing command: no
 * step failed here, and a fabricated failure would put bogus evidence in the
 * journal for a flow whose steps all ran correctly.
 */
export function completionMarker(reason: LoweredCompletionReason): string {
  return reason === 'success' ? ':' : `printf '%s' '{"completionReason":"${reason}"}'`;
}

function assertOperationAllowed(
  verb: string,
  flowName: string,
  completion: FlowCompletionReason | undefined,
): void {
  if (completion !== undefined) {
    throw new AuthoredFlowExecutionError(
      'operation_after_completion',
      `flow "${flowName}" called f.${verb} after done()`,
      isSurfaceRunCompletionReason(completion) ? completion : undefined,
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
