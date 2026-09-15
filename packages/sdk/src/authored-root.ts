import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { canonicalize } from './canonical.js';
import { compileSpec, toKernelSpec } from './compile.js';
import { executeAuthoredFlow, type AuthoredFlowExecutionResult } from './authored-flow-executor.js';
import {
  loadAuthoredFlow,
  type LoadedAuthoredFlow,
  type SurfaceModuleAuthority,
} from './authored-flow-loader.js';
import { JournalClient } from './journal-client.js';
import type { RunOutcome, StepDispatchEvent } from './protocol.js';
import { SPEC_SCHEMA_VERSION } from './spec.js';
import type { RunLifecycleOptions } from './cli/run.js';

const ROOT_KIND = 'relayflows.authored-root.v1';

export interface AuthoredRootMetadata {
  readonly kind: typeof ROOT_KIND;
  readonly flowName: string;
  readonly flowPath: string;
  readonly sourceSha256: string;
  readonly surface: SurfaceModuleAuthority;
  readonly sources: readonly AuthoredRootSourceAuthority[];
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
  readonly dataDir: string;
  readonly admissionKey?: string;
  readonly localAgentStream?: string;
  readonly lifecycle?: RunLifecycleOptions;
}

/** Admit and execute one authored body under a durable kernel root. */
export async function executeDurableAuthoredFlow(
  loaded: LoadedAuthoredFlow,
  journal: JournalClient,
  input: unknown,
  options: DurableAuthoredOptions,
): Promise<AuthoredFlowExecutionResult & { readonly rootRunId: string }> {
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
    if (outcome.status === 'completed') {
      dispatchWait.cancel();
      return await completedRootResult(journal, outcome.run_id);
    }
    assertRootCanDispatch(outcome);
    const dispatch = await dispatchWait.promise;
    return await driveRoot(loaded, metadata, journal, peer, dispatch, options);
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
): Promise<(AuthoredFlowExecutionResult & { readonly rootRunId: string }) | undefined> {
  const metadata = await readAuthoredRootMetadata(journal, rootRunId);
  if (metadata === undefined) return undefined;
  const source = await readFile(metadata.flowPath);
  if (sha256(source) !== metadata.sourceSha256) {
    throw new Error('authored root source authority mismatch');
  }
  for (const pinned of metadata.sources) {
    if (sha256(await readFile(pinned.path)) !== pinned.sourceSha256) {
      throw new Error(`authored root source authority mismatch for "${pinned.path}"`);
    }
  }
  const loaded = await loadAuthoredFlow(metadata.flowPath);
  if (canonicalize(loaded.surfaceAuthority) !== canonicalize(metadata.surface)
    || loaded.getDefinition(loaded.handle).name !== metadata.flowName) {
    throw new Error('authored root Surface module authority mismatch');
  }
  const loadedSources = loaded.graph.map(node => ({
    path: node.path,
    sourceSha256: metadata.sources.find(source => source.path === node.path)?.sourceSha256 ?? '',
    surface: node.surfaceAuthority,
  }));
  if (canonicalize(loadedSources) !== canonicalize(metadata.sources)) {
    throw new Error('authored root declared source graph authority mismatch');
  }
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
    if (outcome.status === 'completed') {
      dispatchWait.cancel();
      return await completedRootResult(journal, rootRunId);
    }
    assertRootCanDispatch(outcome);
    const dispatch = await dispatchWait.promise;
    return await driveRoot(loaded, metadata, journal, peer, dispatch, options);
  } finally {
    cancelDispatch();
    peer.close();
  }
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
  return value;
}

async function driveRoot(
  loaded: LoadedAuthoredFlow,
  metadata: AuthoredRootMetadata,
  journal: JournalClient,
  peer: JournalClient,
  dispatch: StepDispatchEvent,
  options: Omit<DurableAuthoredOptions, 'admissionKey'>,
): Promise<AuthoredFlowExecutionResult & { readonly rootRunId: string }> {
  try {
    const result = await executeAuthoredFlow(
      loaded.handle,
      journal,
      metadata.inputPresent ? metadata.input : undefined,
      {
        getDefinition: loaded.getDefinition,
        dataDir: options.dataDir,
        flowPath: metadata.flowPath,
        localAgentStream: options.localAgentStream,
        rootRunId: dispatch.run_id,
        ...options.lifecycle,
      },
    );
    await peer.stepComplete(
      dispatch.run_id, dispatch.step_id, dispatch.attempt,
      dispatch.idempotency_key, 'success', {
        output: { name: result.name, completionReason: result.completionReason,
          journalSteps: result.journalSteps },
        started_pins: dispatch.pins, end_pins: dispatch.pins,
      },
    );
    return Object.freeze({ ...result, rootRunId: dispatch.run_id });
  } catch (error) {
    await terminalizeRootFailure(peer, dispatch, error);
    throw error;
  }
}

/**
 * A returned body failure is deterministic for this root attempt. Complete
 * every kernel retry with the same declared failure so the run reaches its
 * durable `step_failed` terminal instead of being stranded waiting for a
 * worker after the CLI has already returned. A process crash never enters
 * this path: the running attempt remains recoverable by `run.resume`.
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
      recoveryMode: 'reset', maxIterations: 8,
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

function nextRootDispatch(peer: JournalClient): {
  promise: Promise<StepDispatchEvent>;
  cancel(): void;
} {
  let cancel = () => {};
  const promise = new Promise<StepDispatchEvent>((resolve, reject) => {
    const timer = setTimeout(() => {
      peer.off('step.dispatch', onDispatch);
      reject(new Error('authored root was not dispatched'));
    }, 30_000);
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
  const output = (completed?.payload as { output?: unknown } | undefined)?.output as
    | Omit<AuthoredFlowExecutionResult, 'rootRunId'> | undefined;
  if (!output || typeof output.name !== 'string' || !Array.isArray(output.journalSteps)) {
    throw new Error('completed authored root has no durable result');
  }
  return Object.freeze({ ...output, rootRunId });
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
    && (root.localAgentStream === undefined
      || /^local-agent-[a-f0-9-]+$/.test(root.localAgentStream));
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
