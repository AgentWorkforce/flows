import { loadPinnedAuthoredSource } from './authored-source-authority.js';
import { assertAuthoredRuntimeAvailable, runAuthoredInNode } from './authored-node-runner.js';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalize } from './canonical.js';
import { compileSpec, toKernelSpec } from './compile.js';
import { executeAuthoredFlow, type AuthoredFlowExecutionResult, type AuthoredFlowSuspendedResult } from './authored-flow-executor.js';
import { isDurableCompletionDetail, isLoweredCompletion } from './authored-completion.js';
import { AUTHORED_ROOT_KIND } from './authored-verdict.js';
import {
  loadAuthoredFlow,
  type LoadedAuthoredFlow,
  type SurfaceModuleAuthority,
} from './authored-flow-loader.js';
import { JournalClient, JournalProtocolError } from './journal-client.js';
import type { RunOutcome, StepDispatchEvent } from './protocol.js';
import { SPEC_SCHEMA_VERSION } from './spec.js';
import type { RunLifecycleOptions } from './cli/run.js';
import { isLeaseLost, withWorkerLease } from './worker-lease.js';
import { AuthoredFlowExecutionError, AuthoredHumanParked } from './authored-flow-error.js';
import { readOpenHumanWaits, resumeCommand } from './authored-human.js';
import { isSurfaceCompletionReason } from './authored-step-output.js';
import { readSubscriptionPark } from './authored-subscription-park.js';
import { localAgentCredentialEnvironment } from './local-agent-environment.js';

export type DurableAuthoredFlowResult =
  | (AuthoredFlowExecutionResult & { readonly rootRunId: string })
  | (AuthoredFlowSuspendedResult & { readonly rootRunId: string });

/**
 * Taken from the projection module rather than spelled twice: `flows status`
 * has to recognise the same root this file writes, and it must not import the
 * executor to do it.
 */
const ROOT_KIND = AUTHORED_ROOT_KIND;

export interface AuthoredRootExtension {
  readonly name: string;
  readonly digest: string;
  readonly ref: string;
}

export interface AuthoredRootMetadata {
  readonly kind: typeof ROOT_KIND;
  readonly flowName: string;
  readonly flowPath: string;
  readonly sourceSha256: string;
  readonly surface: SurfaceModuleAuthority;
  readonly sources: readonly AuthoredRootSourceAuthority[];
  /** Plugin-level provenance in lock order; empty when the project declares none. */
  readonly extensions: readonly AuthoredRootExtension[];
  readonly localAgentStream?: string;
  readonly inputPresent: boolean;
  readonly input?: unknown;
}

export interface AuthoredRootSourceAuthority {
  readonly path: string;
  readonly sourceSha256: string;
  readonly surface: SurfaceModuleAuthority;
}

export interface DurableAuthoredOptions {
  /** Preserve root authority even if a child later fails or parks. */
  readonly onAdmitted?: (runId: string) => void;
  readonly dataDir: string;
  readonly admissionKey?: string;
  readonly localAgentStream?: string;
  /** Concurrency of the attached local workers; see `ExecuteAuthoredFlowOptions.workerCapacity`. */
  readonly workerCapacity?: number;
  /** Provider-only environment consumed by preflight and local workers. */
  readonly agentEnvironment?: NodeJS.ProcessEnv;
  readonly lifecycle?: RunLifecycleOptions;
}

/** Admit and execute one authored body under a durable kernel root. */
export async function executeDurableAuthoredFlow(
  loaded: LoadedAuthoredFlow,
  journal: JournalClient,
  input: unknown,
  options: DurableAuthoredOptions,
): Promise<DurableAuthoredFlowResult> {
  assertAuthoredRuntimeAvailable();
  const source = await readFile(loaded.sourcePath);
  const sources = await Promise.all(loaded.graph.map(async node => Object.freeze({
    path: node.path,
    sourceSha256: sha256(await readFile(node.path)),
    surface: node.surfaceAuthority,
  })));
  const definition = loaded.getDefinition(loaded.handle);
  const metadata: AuthoredRootMetadata = Object.freeze({
    kind: ROOT_KIND,
    flowName: definition.name,
    flowPath: loaded.sourcePath,
    sourceSha256: sha256(source),
    surface: loaded.surfaceAuthority,
    sources: Object.freeze(sources),
    extensions: Object.freeze((loaded.extensions ?? []).map(extension => Object.freeze({
      name: extension.name, digest: extension.digest, ref: extension.ref,
    }))),
    ...(options.localAgentStream === undefined ? {} : { localAgentStream: options.localAgentStream }),
    inputPresent: input !== undefined,
    ...(input === undefined ? {} : { input: jsonSnapshot(input, 'authored root input') }),
  });
  const admissionKey = rootAdmissionKey(options.admissionKey ?? randomUUID());
  const stream = `authored-root-${admissionKey.slice(-40)}`;
  const spec = rootSpec(metadata, stream);
  const peer = journal.createPeer();
  await peer.connect();
  await peer.hello('flows-authored-root');
  let cancelDispatch = () => {};
  try {
    const dispatchWait = nextRootDispatch(peer);
    cancelDispatch = dispatchWait.cancel;
    await peer.workerAttach(`worker-${stream}`, ['agent'], {
      workspace: [], streams: [{ stream, read_offset: 0 }],
    });
    const outcome = await journal.runStart(spec, undefined, admissionKey);
    options.onAdmitted?.(outcome.run_id);
    options.lifecycle?.onRunReceipt?.({ runId: outcome.run_id, flow: definition.name });
    if (outcome.status === 'completed') {
      dispatchWait.cancel();
      return await completedRootResult(journal, outcome.run_id);
    }
    assertRootCanDispatch(outcome);
    options.lifecycle?.onRunStarted?.({ runId: outcome.run_id, flow: definition.name });
    // `run.start` is an idempotent receipt. If the first caller died after
    // the daemon dispatched this root, a same-daemon retry sees the existing
    // active run but receives no second dispatch from start itself. Resume is
    // safe for the first caller too: the daemon preserves a live lease and
    // redelivers only when the former worker connection is gone.
    const resumed = await journal.runResume(outcome.run_id);
    await assertNoOpenHumanWait(journal, resumed);
    const parked = await readSubscriptionPark(journal, outcome.run_id);
    if (parked !== undefined) return { state: 'suspended', name: metadata.flowName,
      suspension: parked, journalSteps: [], rootRunId: outcome.run_id };
    const dispatch = await dispatchWait.promise;
    return await driveRootFollowingRetries(loaded, metadata, journal, peer, dispatch, options);
  } finally {
    cancelDispatch();
    peer.close();
  }
}

/** Resume the exact source and Surface instance recorded by an authored root. */
export async function resumeDurableAuthoredFlow(
  rootRunId: string,
  journal: JournalClient,
  options: Omit<DurableAuthoredOptions, 'admissionKey'>,
): Promise<DurableAuthoredFlowResult | undefined> {
  const metadata = await readAuthoredRootMetadata(journal, rootRunId);
  if (metadata === undefined) return undefined;
  assertAuthoredRuntimeAvailable();
  const loaded = await loadPinnedAuthoredSource(metadata);
  if (metadata.localAgentStream !== options.localAgentStream) {
    throw new Error('authored root local agent surface mismatch');
  }
  const stream = rootStreamFromMetadata(await rootKernelStep(journal, rootRunId));
  const peer = journal.createPeer();
  await peer.connect();
  await peer.hello('flows-authored-root-resume');
  let cancelDispatch = () => {};
  try {
    const dispatchWait = nextRootDispatch(peer);
    cancelDispatch = dispatchWait.cancel;
    await peer.workerAttach(`worker-${stream}-${randomUUID()}`, ['agent'], {
      workspace: [], streams: [{ stream, read_offset: 0 }],
    });
    const outcome = await journal.runResume(rootRunId);
    options.lifecycle?.onRunReceipt?.({ runId: rootRunId, flow: metadata.flowName });
    if (outcome.status === 'completed') {
      dispatchWait.cancel();
      return await completedRootResult(journal, rootRunId);
    }
    assertRootCanDispatch(outcome);
    await assertNoOpenHumanWait(journal, outcome);
    options.lifecycle?.onRunStarted?.({ runId: rootRunId, flow: metadata.flowName, resumed: true });
    const parked = await readSubscriptionPark(journal, rootRunId);
    if (parked !== undefined) return { state: 'suspended', name: metadata.flowName,
      suspension: parked, journalSteps: [], rootRunId };
    const dispatch = await dispatchWait.promise;
    return await driveRootFollowingRetries(loaded, metadata, journal, peer, dispatch, options);
  } finally {
    cancelDispatch();
    peer.close();
  }
}

/**
 * A root parked on an unanswered `f.human` will not be dispatched: the
 * kernel holds it in `needs_human` until `event.emit` closes the wait. Report
 * the open question instead of waiting for a dispatch that cannot arrive.
 */
async function assertNoOpenHumanWait(journal: JournalClient, outcome: RunOutcome): Promise<void> {
  if (outcome.status !== 'parked') return;
  const [open] = await readOpenHumanWaits(journal, outcome.run_id);
  if (open !== undefined) throw new AuthoredHumanParked(open, outcome.run_id);
}

export async function readAuthoredRootMetadata(
  journal: JournalClient,
  runId: string,
): Promise<AuthoredRootMetadata | undefined> {
  const step = await rootKernelStep(journal, runId).catch(() => undefined);
  if (step === undefined || step.id !== 'authored-root' || !hasRootStream(step)) return undefined;
  if (typeof step.instruction !== 'string') {
    throw new Error('authored root journal has malformed authority metadata');
  }
  let value: unknown;
  try { value = JSON.parse(step.instruction); } catch {
    throw new Error('authored root journal has malformed authority metadata');
  }
  if (!isRootMetadata(value)) {
    throw new Error('authored root journal has malformed authority metadata');
  }
  return Object.freeze({ ...value, extensions: value.extensions ?? [] });
}

/**
 * How many times one CLI re-drives a root whose lease it lost. Each re-drive
 * replays completed steps from their journaled receipts, so the bound guards a
 * lease that keeps being lost, not the cost of the work.
 */
const MAX_ROOT_REDRIVES = 3;
/**
 * How long to wait for the kernel to re-dispatch a root whose lease was lost:
 * a full lease (30s, relayflowd LEASE_RENEWAL_MS) in case the daemon still
 * held it, plus its sweep and grace.
 */
const ROOT_REDISPATCH_TIMEOUT_MS = 45_000;

/**
 * Drive the root, and FOLLOW the kernel when it retries the root attempt.
 *
 * A lost root lease is not a failed flow. The kernel journals the attempt
 * `lease_expired` with `disposition: retry` without charging an iteration
 * (relayflowd-core recovery.rs) and re-dispatches the root to the worker
 * still attached on `peer` -- this process. Exiting there with
 * "worker wait canceled" (customer rw_3a0fcb71) threw away a run the kernel
 * was about to continue, including a child agent already on its second
 * attempt: the re-driven body replays completed steps from their receipts and
 * adopts that in-flight child (authored-step-output.ts). Only when no retry
 * arrives does the error leave, as `root_lease_lost` naming the resume.
 */
async function driveRootFollowingRetries(
  loaded: LoadedAuthoredFlow,
  metadata: AuthoredRootMetadata,
  journal: JournalClient,
  peer: JournalClient,
  firstDispatch: StepDispatchEvent,
  options: Omit<DurableAuthoredOptions, 'admissionKey'>,
): Promise<DurableAuthoredFlowResult> {
  let dispatch = firstDispatch;
  for (let redrives = 0; ; redrives += 1) {
    // Listen before driving: the retry can be dispatched the moment the
    // daemon sweeps the lease, before the aborted body has unwound. The
    // timeout starts only once there is a lost lease to wait on.
    const next = rootRedispatch(peer);
    try {
      const result = await driveRoot(loaded, metadata, journal, peer, dispatch, options);
      next.cancel();
      return result;
    } catch (error) {
      // `run_terminal` from a step verb means the run has already reached a
      // terminal state. It is lease-shaped for worker cleanup, but the kernel
      // cannot re-dispatch this root, so do not turn it into a 45s retry wait.
      const terminal = error instanceof JournalProtocolError && error.code === 'run_terminal';
      if (!isLeaseLost(error) || terminal || options.lifecycle?.signal?.aborted === true) {
        next.cancel();
        throw error;
      }
      const lost = sentence(error instanceof Error ? error.message : String(error));
      const resume = resumeCommand(dispatch.run_id, options.dataDir, options.localAgentStream !== undefined);
      if (redrives >= MAX_ROOT_REDRIVES) {
        next.cancel();
        throw rootLeaseLost(dispatch, `${lost} It was lost ${redrives + 1} times in this process; continue the run with: ${resume}`, error);
      }
      process.emitWarning(
        `authored root run_id=${dispatch.run_id} attempt=${dispatch.attempt}: ${lost} Waiting for the kernel to retry it.`,
        { code: 'FLOWS_ROOT_LEASE_LOST' },
      );
      try {
        dispatch = await next.wait(ROOT_REDISPATCH_TIMEOUT_MS, options.lifecycle?.signal);
      } catch (waitError) {
        // A caller cancel while waiting is the caller's, not a lost lease.
        if (aborted(options.lifecycle?.signal)) throw waitError;
        throw rootLeaseLost(dispatch, `${lost} The kernel did not re-dispatch the root within ${ROOT_REDISPATCH_TIMEOUT_MS / 1000}s; continue the run with: ${resume}`, error);
      }
      if (dispatch.run_id !== firstDispatch.run_id) {
        throw new Error('authored root retry was dispatched for a different run');
      }
    }
  }
}

/** Read at call time: `signal.aborted` changes while this function awaits. */
function aborted(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true;
}

function sentence(text: string): string {
  return /[.!?]$/.test(text) ? text : `${text}.`;
}

function rootLeaseLost(dispatch: StepDispatchEvent, message: string, cause: unknown): AuthoredFlowExecutionError {
  const error = new AuthoredFlowExecutionError('root_lease_lost',
    `authored root run ${dispatch.run_id} lost its worker lease on attempt ${dispatch.attempt}. ${message}`
      + ' Completed steps are journaled and are not re-run.',
    'lease_expired');
  error.rootRunId = dispatch.run_id;
  (error as { cause?: unknown }).cause = cause;
  return error;
}

async function driveRoot(
  loaded: LoadedAuthoredFlow,
  metadata: AuthoredRootMetadata,
  journal: JournalClient,
  peer: JournalClient,
  dispatch: StepDispatchEvent,
  options: Omit<DurableAuthoredOptions, 'admissionKey'>,
): Promise<DurableAuthoredFlowResult> {
  try {
    const result = await withWorkerLease(peer, dispatch, async rootSignal => {
      const callerSignal = options.lifecycle?.signal;
      const signal = callerSignal === undefined ? rootSignal : AbortSignal.any([callerSignal, rootSignal]);
      if (process.versions['bun'] !== undefined) {
        return runAuthoredInNode(metadata, journal.socketPath, dispatch.run_id, {
          dataDir: options.dataDir, localAgentStream: options.localAgentStream,
          ...(options.agentEnvironment === undefined ? {} : {
            agentEnvironment: localAgentCredentialEnvironment(options.agentEnvironment),
          }),
          ...(options.workerCapacity === undefined ? {} : { workerCapacity: options.workerCapacity }),
          ...options.lifecycle, signal,
        });
      }
      return await executeAuthoredFlow(
        loaded.handle,
        journal,
        metadata.inputPresent ? metadata.input : undefined,
        {
          getDefinition: loaded.getDefinition,
          dataDir: options.dataDir,
          flowPath: metadata.flowPath,
          localAgentStream: options.localAgentStream,
          ...(options.agentEnvironment === undefined ? {} : { agentEnvironment: options.agentEnvironment }),
          ...(options.workerCapacity === undefined ? {} : { workerCapacity: options.workerCapacity }),
          rootRunId: dispatch.run_id,
          extensions: loaded.extensions,
          flowGraph: loaded.graph,
          ...options.lifecycle,
          signal: callerSignal === undefined
            ? rootSignal
            : AbortSignal.any([callerSignal, rootSignal]),
        },
      );
    });
    await peer.stepComplete(
      dispatch.run_id, dispatch.step_id, dispatch.attempt,
      dispatch.idempotency_key, 'success', {
        output: { name: result.name, completionReason: result.completionReason,
          ...(result.completionDetail === undefined ? {} : { completionDetail: result.completionDetail }),
          journalSteps: result.journalSteps,
          ...(result.executionRuntime === undefined ? {} : { executionRuntime: result.executionRuntime }) },
        started_pins: dispatch.pins, end_pins: dispatch.pins,
      },
    );
    return Object.freeze({ ...result, rootRunId: dispatch.run_id });
  } catch (error) {
    // A lost lease is owned by the kernel's retry path, not by this attempt's
    // terminalization or suspension handling.
    if (isLeaseLost(error)) throw error;
    if (error instanceof AuthoredFlowExecutionError
      && error.code === 'subscription_suspended'
      && error.suspension !== undefined) {
      await peer.subscriptionPark({ run_id: dispatch.run_id, step_id: dispatch.step_id,
        attempt: dispatch.attempt, idempotency_key: dispatch.idempotency_key,
        subscription_id: error.suspension.subscriptionId, phase: error.suspension.kind });
      return Object.freeze({ state: 'suspended' as const, name: metadata.flowName,
        suspension: error.suspension, journalSteps: Object.freeze([]), rootRunId: dispatch.run_id });
    }
    if (error instanceof AuthoredHumanParked) {
      // Not a failure: the body reached a question nobody has answered. Park
      // THIS attempt on the kernel's `wait.human` under the body's own wait
      // id, so the answer (`event.emit` keyed by it) re-dispatches the root
      // and the re-run body finds it. The lease is released by the verb; the
      // signal propagates so the CLI reports the question with exit 3.
      await peer.stepWait(dispatch.run_id, dispatch.step_id, dispatch.attempt, dispatch.idempotency_key, {
        wait_id: error.wait.waitId, prompt: error.wait.question, requested_of: error.wait.to,
        options: ['yes', 'no'],
      });
      throw error;
    }
    await terminalizeRootFailure(peer, dispatch, error);
    if (error instanceof AuthoredFlowExecutionError) error.rootRunId = dispatch.run_id;
    throw error;
  }
}

/**
 * A returned body failure is deterministic for this root attempt and is
 * completed once as terminal `worker_error`. A process crash never enters
 * this path: the running attempt remains recoverable by `run.resume` under
 * the root's separate transport retry budget.
 */
async function terminalizeRootFailure(
  peer: JournalClient,
  firstDispatch: StepDispatchEvent,
  error: unknown,
): Promise<void> {
  let dispatch = firstDispatch;
  const output = { error: error instanceof Error ? error.message : 'authored root failed' };
  for (;;) {
    const next = nextRootDispatch(peer);
    let outcome: RunOutcome;
    try {
      outcome = await peer.stepComplete(
        dispatch.run_id, dispatch.step_id, dispatch.attempt,
        dispatch.idempotency_key, 'worker_error', {
          output, started_pins: dispatch.pins, end_pins: dispatch.pins,
        },
      );
    } catch (completionError) {
      next.cancel();
      throw completionError;
    }
    if (outcome.status === 'failed') {
      next.cancel();
      return;
    }
    try { assertRootCanDispatch(outcome); } catch (outcomeError) {
      next.cancel();
      throw outcomeError;
    }
    dispatch = await next.promise;
    if (dispatch.run_id !== firstDispatch.run_id) {
      throw new Error('authored root retry was dispatched for a different run');
    }
  }
}

function rootSpec(metadata: AuthoredRootMetadata, stream: string) {
  return toKernelSpec(compileSpec({
    version: SPEC_SCHEMA_VERSION,
    name: `authored-root/${metadata.flowName}`,
    steps: [{
      id: 'authored-root', type: 'agent',
      instruction: canonicalize(metadata),
      surfaces: { streams: [{ stream }] },
      recoveryMode: 'reset', maxIterations: 1, transportRetries: 7,
    }],
  }));
}

async function rootKernelStep(journal: JournalClient, runId: string): Promise<Record<string, unknown>> {
  const entries = (await journal.journalRead(runId, 1)).entries as Array<Record<string, unknown>>;
  const spawned = entries.find(entry => entry.entry_type === 'run.spawned');
  const payload = spawned?.payload as { spec?: { steps?: unknown[] } } | undefined;
  const step = payload?.spec?.steps?.[0];
  if (typeof step !== 'object' || step === null || Array.isArray(step)) {
    throw new Error('authored root journal has no root step');
  }
  return step as Record<string, unknown>;
}

function rootStreamFromMetadata(step: Record<string, unknown>): string {
  const surfaces = step.surfaces as { streams?: Array<{ stream?: unknown }> } | undefined;
  const stream = surfaces?.streams?.[0]?.stream;
  if (typeof stream !== 'string' || !stream.startsWith('authored-root-')) {
    throw new Error('authored root journal has no pinned stream');
  }
  return stream;
}

function hasRootStream(step: Record<string, unknown>): boolean {
  try { rootStreamFromMetadata(step); return true; } catch { return false; }
}

/**
 * Buffers the next root dispatch from the moment it is created; `wait`
 * bounds only the time spent waiting for it. Unlike `nextRootDispatch`, no
 * timer runs while the body is being driven -- a body longer than the
 * timeout must not leave a rejected promise nobody awaits.
 */
function rootRedispatch(peer: JournalClient): {
  wait(timeoutMs: number, signal?: AbortSignal): Promise<StepDispatchEvent>;
  cancel(): void;
} {
  let received: StepDispatchEvent | undefined;
  let deliver: ((dispatch: StepDispatchEvent) => void) | undefined;
  const onDispatch = (dispatch: StepDispatchEvent): void => {
    if (dispatch.step_id !== 'authored-root') return;
    peer.off('step.dispatch', onDispatch);
    if (deliver === undefined) received = dispatch;
    else deliver(dispatch);
  };
  peer.on('step.dispatch', onDispatch);
  const cancel = (): void => { peer.off('step.dispatch', onDispatch); };
  return {
    cancel,
    wait: (timeoutMs, signal) => new Promise((resolve, reject) => {
      if (received !== undefined) { resolve(received); return; }
      const settle = (): void => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', onAbort);
        cancel();
      };
      const onAbort = (): void => {
        settle();
        reject(new Error('waiting for the authored root to be re-dispatched was canceled', { cause: signal?.reason }));
      };
      const timer = setTimeout(() => {
        settle();
        reject(new Error('authored root was not re-dispatched'));
      }, timeoutMs);
      deliver = dispatch => { settle(); resolve(dispatch); };
      if (signal?.aborted === true) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
    }),
  };
}

function nextRootDispatch(peer: JournalClient, timeoutMs = 30_000): {
  promise: Promise<StepDispatchEvent>;
  cancel(): void;
} {
  let cancel = () => {};
  const promise = new Promise<StepDispatchEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      peer.off('step.dispatch', onDispatch);
      reject(new Error('authored root was not dispatched'));
    }, timeoutMs);
    const onDispatch = (dispatch: StepDispatchEvent) => {
      if (dispatch.step_id !== 'authored-root') return;
      clearTimeout(timer);
      peer.off('step.dispatch', onDispatch);
      resolve(dispatch);
    };
    peer.on('step.dispatch', onDispatch);
    cancel = () => {
      clearTimeout(timer);
      peer.off('step.dispatch', onDispatch);
    };
  });
  return { promise, cancel };
}

async function completedRootResult(
  journal: JournalClient,
  rootRunId: string,
): Promise<AuthoredFlowExecutionResult & { readonly rootRunId: string }> {
  const entries = (await journal.journalRead(rootRunId, 1)).entries as Array<Record<string, unknown>>;
  const completed = entries.slice().reverse().find(entry => entry.entry_type === 'step.completed'
    && entry.step_id === 'authored-root'
    && (entry.payload as { completionReason?: unknown } | undefined)?.completionReason === 'success');
  const output = (completed?.payload as { output?: unknown } | undefined)?.output;
  if (!isCompletedRootOutput(output)) {
    throw new Error('completed authored root has no durable result');
  }
  // The stored detail, never a freshly computed one: redaction reads the
  // CURRENT environment, so recomputing here would let a completed run report
  // something its journal does not hold.
  return Object.freeze({
    name: output.name,
    completionReason: output.completionReason,
    ...(output.completionDetail === undefined ? {} : { completionDetail: output.completionDetail }),
    journalSteps: Object.freeze(output.journalSteps.map(step => Object.freeze({ ...step }))),
    rootRunId,
  });
}

function isCompletedRootOutput(value: unknown): value is Omit<AuthoredFlowExecutionResult, 'rootRunId'> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const output = value as Partial<AuthoredFlowExecutionResult>;
  return typeof output.name === 'string'
    && isLoweredCompletion(output.completionReason)
    // A malformed detail fails the whole readback rather than being dropped:
    // silently discarding it would report the verdict without the evidence
    // the journal says it was recorded with.
    && (output.completionDetail === undefined || isDurableCompletionDetail(output.completionDetail))
    && Array.isArray(output.journalSteps)
    && output.journalSteps.every(step => typeof step === 'object' && step !== null
      && typeof step.id === 'string' && typeof step.runId === 'string'
      && isSurfaceCompletionReason(step.completionReason));
}

function assertRootCanDispatch(outcome: RunOutcome): void {
  // The kernel reports `parked` after handing an agent lease to its worker;
  // the pushed dispatch is the authority that work is live. An idempotent
  // start retry may instead observe the same active state as `running`.
  if (outcome.status === 'running' || outcome.status === 'parked') return;
  throw new Error(`authored root "${outcome.run_id}" is ${outcome.status}`
    + (outcome.completion_reason === null ? '' : ` (${outcome.completion_reason})`));
}

function rootAdmissionKey(value: string): string {
  return `authored-root:${createHash('sha256').update(value).digest('hex')}`;
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function jsonSnapshot(value: unknown, label: string): unknown {
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error(`${label} is not JSON serializable`);
  return JSON.parse(encoded) as unknown;
}

function isRootMetadata(value: unknown): value is AuthoredRootMetadata {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const root = value as Partial<AuthoredRootMetadata>;
  const surface = root.surface as Partial<SurfaceModuleAuthority> | undefined;
  const sources = root.sources;
  return root.kind === ROOT_KIND && typeof root.flowName === 'string'
    && typeof root.flowPath === 'string' && /^[a-f0-9]{64}$/.test(root.sourceSha256 ?? '')
    && typeof root.inputPresent === 'boolean' && surface?.packageName === '@relayflows/surface'
    && typeof surface.version === 'string' && /^[a-f0-9]{64}$/.test(surface.packageSha256 ?? '')
    && /^[a-f0-9]{64}$/.test(surface.runtimeSha256 ?? '')
    && Array.isArray(sources) && sources.length > 0 && sources.every(isRootSourceAuthority)
    && (root.extensions === undefined || (Array.isArray(root.extensions) && root.extensions.every(isRootExtension)))
    && (root.localAgentStream === undefined
      || /^local-agent-[a-f0-9-]+$/.test(root.localAgentStream));
}

function isRootExtension(value: unknown): value is AuthoredRootExtension {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const extension = value as Partial<AuthoredRootExtension>;
  return typeof extension.name === 'string' && extension.name.length > 0
    && /^[a-f0-9]{64}$/.test(extension.digest ?? '')
    && typeof extension.ref === 'string' && extension.ref.startsWith('github:');
}

function isRootSourceAuthority(value: unknown): value is AuthoredRootSourceAuthority {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const source = value as Partial<AuthoredRootSourceAuthority>;
  const surface = source.surface as Partial<SurfaceModuleAuthority> | undefined;
  return typeof source.path === 'string' && /^[a-f0-9]{64}$/.test(source.sourceSha256 ?? '')
    && surface?.packageName === '@relayflows/surface' && typeof surface.version === 'string'
    && /^[a-f0-9]{64}$/.test(surface.packageSha256 ?? '')
    && /^[a-f0-9]{64}$/.test(surface.runtimeSha256 ?? '');
}
