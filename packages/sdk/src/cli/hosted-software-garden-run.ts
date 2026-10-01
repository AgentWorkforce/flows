import { createHash, randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { compileSpec, toKernelSpec } from '../compile.js';
import { runtimeVersions } from '../flow-extension-compat.js';
import {
  hostedExtensionDispatchIdentity,
  type HostedEventIdentity,
} from '../flow-extension-loader.js';
import { assertHostedDataDirectoryIsolated } from '../hosted-data-directory.js';
import {
  loadHostedExtensionRuntime,
  normalizeHostedBabysitterInput,
  runHostedCapabilityExtension,
  selectHostedExtensionForRuntime,
  type RunHostedSoftwareGardenBabysitterOptions,
} from '../hosted-extension-isolation.js';
import { atomicJson, readHelperReceipt } from '../helper-storage.js';
import { JournalClient, JournalProtocolError } from '../journal-client.js';
import { PluginError } from '../plugin-manifest.js';
import type { RunOutcome, StepDispatchEvent } from '../protocol.js';
import { SPEC_SCHEMA_VERSION } from '../spec.js';
import { withWorkerLease } from '../worker-lease.js';
import {
  classifyOutcome,
  connect,
  emptyReport,
  protocolFailure,
  socketFor,
  type RunExecution,
  type RunLifecycleOptions,
  type RunReport,
} from './run.js';

const STEP_ID = 'babysitter-turn';
const SURFACE_PATH = '/cloud/babysitter-turn';

export type HostedSoftwareGardenRunOptions = Omit<
  RunHostedSoftwareGardenBabysitterOptions,
  'flowPath' | 'input' | 'bubblewrapPath' | 'nodePath' | 'prlimitPath'
>;

/**
 * Execute the pinned hosted composition as one journaled effect step. Plugin,
 * pin, route, and base refusals are resolved before a run exists;
 * every error after admission is a terminal step failure because the external
 * queue outcome may already be in doubt.
 */
export async function runHostedSoftwareGardenFlow(
  path: string,
  input: unknown,
  dataDir: string,
  hosted: HostedSoftwareGardenRunOptions,
  lifecycle: RunLifecycleOptions,
): Promise<RunExecution> {
  const base: RunReport = { ...emptyReport('run'), path };
  let identity: HostedEventIdentity;
  let normalizedInput: unknown;
  let runtime: Awaited<ReturnType<typeof loadHostedExtensionRuntime>>;
  let selected: Awaited<ReturnType<typeof selectHostedExtensionForRuntime>>;
  try {
    identity = hostedExtensionDispatchIdentity(hosted.dispatch);
    normalizedInput = normalizeHostedBabysitterInput(input, hosted.dispatch);
    await assertHostedDataDirectoryIsolated(path, dataDir);
    runtime = await loadHostedExtensionRuntime(path);
    selected = await selectHostedExtensionForRuntime(
      runtime.installation,
      runtime.base,
      identity,
      runtimeVersions(),
    );
  } catch (error) {
    if (error instanceof PluginError) return pluginRefusal(base, error);
    return hostedFailure(base, error);
  }

  const socketPath = socketFor(dataDir);
  const client = new JournalClient(socketPath);
  const connected = await connect(client, 'run', dataDir, base, lifecycle);
  if (connected !== undefined) return connected;

  const admissionIdentity = {
    provider: identity.provider,
    eventType: hosted.dispatch.eventType,
    deliveryId: hosted.dispatch.deliveryId,
    base: runtime.base,
    extension: {
      name: selected.manifest.name,
      version: selected.manifest.version,
      ref: selected.artifact.ref,
      digest: selected.artifact.digest,
      manifestSha256: selected.artifact.manifestSha256,
    },
  };
  const admissionDigest = createHash('sha256')
    .update(JSON.stringify(admissionIdentity))
    .digest('hex');
  const stream = `hosted-babysitter-${admissionDigest}`;
  const instruction = JSON.stringify({
    type: 'effect',
    provider: 'cloud',
    verb: 'babysitter-turn',
    identity,
    authority: admissionIdentity,
    input: normalizedInput,
  });
  const spec = toKernelSpec(compileSpec({
    version: SPEC_SCHEMA_VERSION,
    name: 'software-factory/hosted-babysitter',
    steps: [{
      id: STEP_ID,
      type: 'agent',
      instruction,
      maxIterations: 1,
      recoveryMode: 'reset',
      surfaces: {
        streams: [{ stream }],
        external: [SURFACE_PATH],
      },
    }],
  }));
  const peer = client.createPeer();
  let work: Promise<HostedCompletion> | undefined;
  let completedWork: HostedCompletion | undefined;
  let capabilityFailed = false;
  let capabilityFailure: unknown;
  let workerFailure: unknown;
  let signalWorkerFailure!: (error: unknown) => void;
  const workerFailureSignal = new Promise<unknown>(resolve => { signalWorkerFailure = resolve; });

  const recordWorkerFailure = (error: unknown): void => {
    workerFailure ??= error;
    signalWorkerFailure(workerFailure);
  };

  const dispatch = (event: StepDispatchEvent): void => {
    const dispatched = event.spec as { instruction?: string; surfaces?: { streams?: { stream: string }[] } };
    if (work !== undefined || event.step_id !== STEP_ID || event.step_type !== 'agent'
      || dispatched.instruction !== instruction
      || !dispatched.surfaces?.streams?.some(pin => pin.stream === stream)) {
      recordWorkerFailure(new Error('Hosted Babysitter worker received an unexpected dispatch.'));
      peer.close(workerFailure);
      return;
    }
    const attempt = completeHostedDispatch(peer, event, runtime, normalizedInput, hosted, dataDir);
    work = attempt;
    void attempt.then(completion => {
      completedWork = completion;
      if (completion.failed) {
        capabilityFailed = true;
        capabilityFailure = completion.failure;
      }
    }, error => {
      recordWorkerFailure(error);
    });
  };

  peer.on('step.dispatch', dispatch);
  peer.on('error', recordWorkerFailure);
  if (lifecycle.onJournalEntry !== undefined) client.on('entry', lifecycle.onJournalEntry);
  try {
    await peer.connect();
    await peer.hello('flows-hosted-babysitter');
    const pins = { workspace: [], streams: [{ stream, read_offset: 0 }] };
    await peer.workerAttach(`hosted-babysitter-${randomUUID()}`, ['agent'], pins, 1, [stream]);
    const admissionKey = `hosted-babysitter:${admissionDigest}`;
    const started = await startHostedRun(
      client,
      spec,
      admissionKey,
      lifecycle.onJournalEntry !== undefined,
    );
    lifecycle.onRunStarted?.({ runId: started.run_id, flow: path });
    // An idempotent concurrent start can observe the original admission while
    // its leased attempt is still running. Resume is live-lease-aware and
    // converts that snapshot into the same parked/terminal shape handled by
    // every other CLI run before classification.
    const outcome = started.status === 'running'
      ? await client.runResume(started.run_id, true)
      : started;
    const classified = await Promise.race([
      classifyOutcome(
        client,
        'run',
        outcome,
        base,
        socketPath,
        { ...lifecycle, dataDir },
      ).then(execution => ({ type: 'execution' as const, execution })),
      workerFailureSignal.then(failure => ({ type: 'worker-failure' as const, failure })),
    ]);
    if (classified.type === 'worker-failure') throw classified.failure;
    let execution = classified.execution;
    // The generic classifier may observe a transient parked/protocol shape
    // after the isolated child is killed even though this dedicated worker is
    // still holding the authoritative, uncancellable capability call. Never
    // close the peer or return that intermediate report while its dispatch is
    // live. The worker completion is the journal boundary for this one-step
    // hosted run; classify its resulting kernel outcome instead.
    const completion = work === undefined ? completedWork : await work;
    if (completion !== undefined) {
      execution = await classifyOutcome(
        client,
        'run',
        completion.outcome,
        base,
        socketPath,
        { ...lifecycle, dataDir },
      );
    }
    if (execution.exitCode !== 1 || !capabilityFailed) return execution;
    return {
      ...execution,
      report: {
        ...execution.report,
        diagnostics: execution.report.diagnostics.map(diagnostic => diagnostic.kind === 'step_failed'
          ? { ...diagnostic, message: errorMessage(capabilityFailure) }
          : diagnostic),
      },
    };
  } catch (error) {
    // Classification/control failure does not cancel an external capability
    // that has already started. Drain its journal completion before closing
    // the peer, otherwise an immediate same-delivery retry can reclaim the
    // recorded-but-unconfirmed election while the first provider write is
    // still in flight.
    let failure = error;
    if (work !== undefined) {
      try {
        await work;
      } catch (settlementError) {
        failure = settlementError;
      }
    }
    return protocolFailure('run', base, socketPath, workerFailure ?? failure);
  } finally {
    if (lifecycle.onJournalEntry !== undefined) client.off('entry', lifecycle.onJournalEntry);
    peer.off('step.dispatch', dispatch);
    peer.close();
    client.close();
  }
}

/** @internal Compatibility seam for deterministic protocol tests. */
export async function startHostedRun(
  client: JournalClient,
  spec: Parameters<JournalClient['runStart']>[0],
  admissionKey: string,
  watch: boolean,
): Promise<RunOutcome> {
  if (!watch) return await client.runStart(spec, undefined, admissionKey);
  try {
    return await client.runStart(spec, undefined, admissionKey, true);
  } catch (error) {
    if (!(error instanceof JournalProtocolError) || error.code !== 'bad_request'
      || !/unknown field `watch`/.test(error.message)) throw error;
    return await client.runStart(spec, undefined, admissionKey);
  }
}

type HostedCompletion =
  | { readonly outcome: RunOutcome; readonly failed: false }
  | { readonly outcome: RunOutcome; readonly failed: true; readonly failure: unknown };

async function completeHostedDispatch(
  peer: JournalClient,
  dispatch: StepDispatchEvent,
  runtime: Awaited<ReturnType<typeof loadHostedExtensionRuntime>>,
  input: unknown,
  hosted: HostedSoftwareGardenRunOptions,
  dataDir: string,
): Promise<HostedCompletion> {
  let result: unknown;
  let effectRecorded = false;
  let failed = false;
  let failure: unknown;
  try {
    result = await withWorkerLease(peer, dispatch, async signal => {
      return await runHostedCapabilityExtension({
        installation: runtime.installation,
        base: runtime.base,
        dispatch: hosted.dispatch,
        input,
        ...(hosted.timeoutMs === undefined ? {} : { timeoutMs: hosted.timeoutMs }),
        babysitterTurn: {
          queue: async (request, authority) => {
            const file = hostedReceiptPath(dataDir, dispatch);
            let receipt: unknown;
            const performed = await peer.performEffect({
              runId: dispatch.run_id,
              stepId: dispatch.step_id,
              attempt: dispatch.attempt,
              idempotencyKey: dispatch.idempotency_key,
              surfacePath: SURFACE_PATH,
              revisionBefore: 'pending',
              revisionAfter: hosted.dispatch.deliveryId,
            }, async () => {
              // performEffect reaches this callback only after effect.record
              // succeeded, so a provider rejection still has a journal fact
              // the failing step completion must carry.
              effectRecorded = true;
              signal.throwIfAborted();
              // A crash after the durable receipt write but before
              // effect.confirm leaves this election reclaimable. Consume that
              // receipt on the reclaimed attempt instead of calling the
              // external provider a second time.
              try {
                receipt = await readHelperReceipt(file);
              } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
                receipt = await hosted.babysitterTurn.queue(request, authority);
                await atomicJson(file, receipt);
              }
              signal.throwIfAborted();
            });
            // Also required after a confirmed election followed by a crash
            // before step.complete. An elected recovery callback may already
            // have populated receipt above, so this is deliberately based on
            // the value rather than only on performEffect's return flag.
            if (!performed) effectRecorded = true;
            if (receipt === undefined) receipt = await readHelperReceipt(file);
            return receipt;
          },
        },
      });
    });
  } catch (error) {
    failed = true;
    failure = error;
  }

  const output = failed
    ? { type: 'hosted-flow-extension', diagnostic: errorMessage(failure) }
    : { type: 'hosted-flow-extension', result };
  const outcome = await peer.stepComplete(
    dispatch.run_id,
    dispatch.step_id,
    dispatch.attempt,
    dispatch.idempotency_key,
    failed ? 'worker_error' : 'success',
    {
      output,
      started_pins: dispatch.pins,
      end_pins: dispatch.pins,
      ...(failed ? { trajectory_tail: output } : {}),
      effects: effectRecorded
        ? [{ surface_path: SURFACE_PATH, idempotency_key: dispatch.idempotency_key }]
        : [],
    },
  );
  return failed ? { outcome, failed: true, failure } : { outcome, failed: false };
}

function hostedReceiptPath(dataDir: string, dispatch: StepDispatchEvent): string {
  const name = createHash('sha256')
    .update(`${dispatch.run_id}:${dispatch.step_id}:${dispatch.idempotency_key}`)
    .digest('hex');
  return join(dataDir, 'hosted-extension-receipts', `${name}.json`);
}

function pluginRefusal(base: RunReport, error: PluginError): RunExecution {
  return {
    exitCode: 2,
    report: {
      ...base,
      diagnostics: [...base.diagnostics, {
        severity: 'refusal',
        kind: error.code,
        message: error.message,
      }],
    },
  };
}

function hostedFailure(
  base: RunReport,
  error: unknown,
  runId?: string,
  socketPath?: string,
  completedSteps?: number,
): RunExecution {
  return {
    exitCode: 1,
    report: {
      ...base,
      ...(runId === undefined ? {} : { runId }),
      ...(socketPath === undefined ? {} : { socketPath }),
      status: 'failed',
      completionReason: 'step_failed',
      ...(completedSteps === undefined ? {} : { completedSteps }),
      diagnostics: [...base.diagnostics, {
        severity: 'failure',
        kind: 'step_failed',
        message: errorMessage(error),
      }],
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Hosted Babysitter capability failed.';
}
