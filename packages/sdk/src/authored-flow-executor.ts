import { pluginHelpers } from './plugin-loader.js';
import { runPluginEffect } from './authored-plugin-effect.js';
import { randomUUID } from 'node:crypto';
import { dirname } from 'node:path';
import { assertSlackCredentials, runSlackEffect } from './authored-slack-effect.js';
import { checkSlackHelpers } from './slack-preflight.js';
import { snapshotJsonValue } from './json-value.js';
import type { SlackCall } from './slack-writeback.js';
import { checkMcpHeader, McpPreflightError } from './cli/check-typescript.js';
import { buildMcpProxy, runMcpEffect } from './authored-mcp.js';
import { AuthoredBudget } from './authored-budget.js';
import { assertMemoryReachable, authoredMemory, scriptMemoryScope } from './authored-memory.js';
import { authoredDeterministicRunner, authoredWorkerRunner } from './authored-worker-step.js';
import { isSurfaceRunCompletionReason } from './authored-step-output.js';
import {
  type LlmOptions,
  type CloudHelper,
  type CompletionReason as SurfaceCompletionReason,
  type Ctx,
  type FlowCompletionReason,
  type RunCompletionReason as SurfaceRunCompletionReason,
  type Step,
} from '@relayflows/surface';
import type { FlowHandle } from '@relayflows/surface/runtime';
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

export interface AuthoredFlowExecutionResult {
  readonly name: string;
  readonly completionReason: FlowCompletionReason;
  readonly journalSteps: readonly AuthoredFlowJournalStep[];
}

type ExecutionResultUsesFlowCompletionReason = Assert<
  Equal<AuthoredFlowExecutionResult['completionReason'], FlowCompletionReason>
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
 * finish with `f.done("success")` or `f.done("needs_human")`. Each step and the terminal marker is
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
  const headerFields = Object.keys(definition.header).filter(key => key !== 'tools' && key !== 'budget' && key !== 'memory');
  if (definition.header.tools && Object.keys(definition.header.tools).some(key => !['slack', 'mcp'].includes(key))) headerFields.push('tools');
  if (definition.header.tools?.relayfile !== undefined) headerFields.push('tools.relayfile');
  const helperPreflight = checkSlackHelpers(definition);
  if (!helperPreflight.ok) assertSlackCredentials();
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
  let requestedCompletion: FlowCompletionReason | undefined;

  const lowerDeterministic = authoredDeterministicRunner(definition.name, journal, journalSteps, budget);

  const worker = authoredWorkerRunner(definition, journal, flowPath, journalSteps, waitOptions, localAgentStream, budget, definition.header.budget);

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

  const slackRun = randomUUID();
  function slackOperation<T>(call: SlackCall): Step<T> {
    assertOperationAllowed(`slack.${call.verb}`, definition.name, requestedCompletion);
    const snapshot = snapshotJsonValue(call, 'f.slack call') as unknown as SlackCall;
    const id = `slack-${slackRun}-${nextStep++}`;
    return trackStep(authoredSteps, new AuthoredFlowOperation<T>(
      id, `slack.${call.verb}`,
      () => assertOperationAllowed(`slack.${call.verb}`, definition.name, requestedCompletion),
      async () => {
        const receipt = await runSlackEffect(journal, definition.name, id, snapshot,
          options.dataDir ?? dirname(journal.socketPath), journalSteps);
        return (call.verb === 'react' ? undefined : receipt) as T;
      },
      lifecycle,
    ));
  }

  const context: Ctx = {
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
          known, checkedMcp.servers[server]!, journalSteps),
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
      return trackStep(authoredSteps, new AuthoredFlowOperation(
        id,
        'run',
        () => assertOperationAllowed('run', definition.name, requestedCompletion),
        () => observeStep(id, 'deterministic', () => lowerDeterministic(id, command, false, leaseMs), options.onProgress),
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
      if (reason !== 'needs_human' && !isSurfaceRunCompletionReason(reason)) {
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
      if (reason !== 'success' && reason !== 'needs_human') {
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

  Object.assign(context, pluginHelpers(checkedMcp.plugins ?? [], (plugin, verb, args) => {
    const label = `${verb.namespace}.${verb.method}`;
    assertOperationAllowed(label, definition.name, requestedCompletion);
    const id = `plugin-${nextStep++}`;
    return trackStep(authoredSteps, new AuthoredFlowOperation(
      id, label, () => assertOperationAllowed(label, definition.name, requestedCompletion),
      () => runPluginEffect(journal, definition.name, id, plugin, verb, args, journalSteps, budget),
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

  // The authored runner has no durable root yet. Record the handoff as a
  // successful effect containing the authored outcome, not a fabricated kernel
  // run.completed reason. The CLI reports this outcome as parked (exit 3).
  await lowerDeterministic(`complete-${nextStep}`, requestedCompletion === 'needs_human'
    ? `printf '%s' '{"completionReason":"needs_human"}'` : ':', true);
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
  completion: FlowCompletionReason | undefined,
): void {
  if (completion !== undefined) {
    throw new AuthoredFlowExecutionError(
      'operation_after_completion',
      `flow "${flowName}" called f.${verb} after done()`,
      completion === 'needs_human' ? undefined : completion,
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
