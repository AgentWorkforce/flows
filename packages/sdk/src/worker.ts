import { brokerInstruction } from './communication/broker-spec.js';
import { communicationInstruction } from './communication/spec.js';
import { workerSpend } from './worker-spend.js';
import { reportedCost } from './reported-cost.js';
import type { WorkerCliResult } from './worker-cli.js';
import { EventEmitter } from 'node:events';
import type { JournalClient } from './journal-client.js';
import type { Pins, StepDispatchEvent } from './protocol.js';
import type { ResolvedKernelAgentStep } from './resolved-cli-identity.js';
import { runAgentCli } from './worker-cli.js';
import { agentCompletionReason } from './cli-transport-evidence.js';
import { agentStepCwd } from './agent-cwd.js';
import { resolveCliModel } from './cli-adapter.js';
import { withWorkerLease } from './worker-lease.js';
import { workerInstruction, workerInstructionIdentity } from './worker-input.js';
import { helperCall } from './yaml-helpers.js';
import { completeHelperDispatch } from './yaml-helper-effect.js';
import {
  ARTIFACT_PATHS_MAX,
  boundTranscriptDigest,
  boundedTail,
  redactText,
  type TranscriptDigest,
} from './agent-transcript.js';
import { createNodeSpawnRuntime, createNodeSpawnRuntimeOwner, explicitServiceCallerFile,
  mergeNodeSpawnEnvironment, type NodeSpawnRuntime, type NodeSpawnRuntimeOwner } from './node-spawn-runtime.js';
import { nodeSpawnCleanupRequired } from './node-spawn-cleanup.js';
import { reconcileNodeResultSettlements } from './node-spawn-settlement.js';
import { readNodeSpawnClaims } from './node-spawn-state.js';

export { MODEL_ENV, WAKE_CONTEXT_ENV } from './worker-cli.js';

export interface AgentWorkerOptions {
  workerId: string;
  pins: Pins;
  capacity?: number;
  requiredStreams?: string[];
  dataDir?: string;
  onPtyReady?: (path: string) => void;
  /**
   * The run root a step's declared `cwd` is resolved against and held inside.
   * Defaults to this process's working directory, which is what the run root
   * is: `flows run` attaches the worker from the directory it was invoked in,
   * and that directory is the uploaded tree on the Cloud path. Named here so
   * the root a dispatch is measured against is a value, not an assumption.
   */
  runRoot?: string;
  /** Source environment; each provider CLI receives only its allowlist and step grants. */
  environment?: NodeJS.ProcessEnv;
  /** Optional approved node-spawn runtime; otherwise relay steps use the agent-token fleet client. */
  nodeSpawnRuntime?: NodeSpawnRuntime;
  /** Explicit Desktop schema-v2 handoff; never discovered from an app-data directory. */
  serviceCallerFile?: string;
}

/**
 * Executes dispatched agent steps using their declared CLI.
 *
 * Shutdown contract (close): async and drain-aware. The caller may await
 * close() to guarantee every dispatch this worker started before close
 * was called has either completed its stepComplete journal write or
 * thrown out through the worker's `error` event. Dispatches that arrive
 * AFTER close begins are ignored. Idempotent.
 *
 * Not implemented: releasing the worker registration with the kernel.
 * `sdk/src/protocol.ts` has no `workerRelease` verb today, so on close()
 * the kernel keeps this workerId in its registry until its lease expires.
 * When workerRelease lands, add a client call at the top of close()
 * (before the drain) so the kernel stops routing dispatches during
 * shutdown.
 */
export class AgentWorker extends EventEmitter {
  private attached = false;
  private closing = false;
  private closePromise?: Promise<void>;
  private settlementTimer?: NodeJS.Timeout;
  private settlementDrain?: Promise<void>;
  private settlementReconcile?: Promise<void>;
  private readonly localDesktopAuthority: boolean;
  private readonly inFlight: Set<Promise<void>> = new Set();
  private readonly nodeSpawnRuntimeOwner: NodeSpawnRuntimeOwner;

  constructor(
    private readonly client: JournalClient,
    private readonly options: AgentWorkerOptions,
  ) {
    super();
    const runtimeEnvironment = mergeNodeSpawnEnvironment(options.environment, options.serviceCallerFile);
    this.localDesktopAuthority = options.nodeSpawnRuntime === undefined
      ? explicitServiceCallerFile(runtimeEnvironment) !== undefined
      : options.nodeSpawnRuntime.authority === 'desktop';
    this.nodeSpawnRuntimeOwner = createNodeSpawnRuntimeOwner(
      options.nodeSpawnRuntime,
      signal => createNodeSpawnRuntime(runtimeEnvironment, { signal }),
    );
  }

  async attach(): Promise<void> {
    if (this.attached) throw new Error('agent worker: already attached');
    if (this.closing) throw new Error('agent worker: cannot attach a closed worker (construct a new one)');
    this.client.on('step.dispatch', this.onDispatch);
    try {
      // An explicit Desktop handoff is fully checkable before this worker is
      // admitted. Bind and validate it now so a missing, expired or mismatched
      // caller cannot let earlier deterministic steps run and fail only when
      // the first Relay dispatch eventually asks for the lazy runtime.
      // Remote fleet authority stays lazy: a direct-only local worker does not
      // need to contact Relay merely because RELAY_AGENT_TOKEN is present.
      if (this.localDesktopAuthority) await this.nodeSpawnRuntimeOwner.get();
      await this.reconcileRelaySettlementsAfterDrain();
      await this.client.workerAttach(
        this.options.workerId,
        ['agent'],
        this.options.pins,
        this.options.capacity,
        this.options.requiredStreams,
      );
      this.attached = true;
    } catch (error) {
      this.client.off('step.dispatch', this.onDispatch);
      if (this.settlementTimer !== undefined) {
        clearTimeout(this.settlementTimer);
        this.settlementTimer = undefined;
      }
      // An attach attempt can create the lazy Relay runtime while reconciling
      // a prior inbox settlement. Once attachment fails, this worker is not
      // reusable: close that owned connection before the caller loses the
      // worker instance.
      this.closing = true;
      try {
        const close = this.nodeSpawnRuntimeOwner.close();
        this.closePromise = close;
        await close;
      } catch (closeError) {
        throw new AggregateError([error, closeError],
          'Agent worker could not attach or close its node runtime');
      }
      throw error;
    }
  }

  /**
   * Async, drain-aware shutdown. Awaits every dispatch in-flight; ignores
   * dispatches that arrive after close() begins. Concurrent and later callers
   * receive the same promise, so none can observe shutdown before the drain.
   *
   * A prior synchronous close() did NOT drain, so a caller shutting
   * mid-dispatch could silently lose an in-flight step's stepComplete
   * journal write when the socket was immediately shut. This closes
   * that hole.
   */
  close(): Promise<void> {
    this.closePromise ??= this.closeOnce();
    return this.closePromise;
  }

  private async closeOnce(): Promise<void> {
    this.closing = true;
    this.client.off('step.dispatch', this.onDispatch);
    const pending = Array.from(this.inFlight);
    if (pending.length > 0) {
      await Promise.allSettled(pending);
    }
    if (this.settlementTimer !== undefined) {
      clearTimeout(this.settlementTimer);
      this.settlementTimer = undefined;
    }
    let settlementError: unknown;
    try {
      await this.reconcileRelaySettlementsAfterDrain();
    } catch (error) {
      settlementError = error;
    }
    try {
      await this.nodeSpawnRuntimeOwner.close();
    } catch (closeError) {
      if (settlementError !== undefined) {
        throw new AggregateError([settlementError, closeError],
          'Agent worker could not reconcile relay settlement or close its node runtime');
      }
      throw closeError;
    } finally {
      this.attached = false;
    }
    if (settlementError !== undefined) throw settlementError;
  }

  private readonly onDispatch = (dispatch: StepDispatchEvent): void => {
    if (this.closing) return;
    if (dispatch.step_type !== 'agent') return;
    const running: Promise<void> = this.executeAfterSettlementDrain(dispatch).catch((error: unknown) => {
      this.emit('error', error, dispatch);
    });
    this.inFlight.add(running);
    void running.finally(() => {
      this.inFlight.delete(running);
      // A task's own ack settles its durable outbox entry after stepComplete.
      // Reconcile only after the dispatch drain: scanning while another relay
      // task is between its journal append and ack can race that task's own
      // settlement and issue the same inbox operation twice.
      if (this.inFlight.size === 0) {
        void this.reconcileRelaySettlementsAfterDrain().catch(error => this.emit('error', error));
      }
    });
  };

  private async executeAfterSettlementDrain(dispatch: StepDispatchEvent): Promise<void> {
    // A dispatch that arrives after a drain can race the drain's asynchronous
    // claim scan. Keep it in the drain count, but do not let it prepare or
    // settle a new delivery until the existing scan has finished.
    while (this.settlementDrain !== undefined) {
      await this.settlementDrain;
    }
    await this.execute(dispatch);
  }

  private async execute(dispatch: StepDispatchEvent): Promise<void> {
    const spec = dispatch.spec as Partial<ResolvedKernelAgentStep>;
    const helper = helperCall(spec);
    if (helper !== undefined) {
      if (this.options.dataDir === undefined) throw new Error('Helper worker requires a data directory for durable receipts');
      await completeHelperDispatch(this.client, dispatch, helper, this.options.dataDir);
      return;
    }
    const broker = brokerInstruction(spec.instruction);
    if (broker) {
      await this.retiredNodeSession(dispatch,
        'transport: broker was removed with the Relay broker. Use transport: relay for one-shot fleet execution; retained local sessions require the pending Desktop service-caller contract.');
      return;
    }
    const communication = communicationInstruction(spec.instruction);
    if (communication) {
      await this.retiredNodeSession(dispatch,
        'Agent communication is unavailable without the retired broker/PTy path. Native node-spawn communication remains fail-closed until an authorized local service caller exists.');
      return;
    }
    let humanIntervention = false;
    const effectiveModel = typeof spec.cli === 'string'
      ? resolveCliModel(spec.cli_identity ?? spec.cli, spec.model)
      : spec.model;
    // Resolved here, before the lease, because this is the process that shares
    // the agent's filesystem. A refusal completes the step the way a missing
    // CLI does — journaled as `worker_error` with the reason — rather than
    // spawning into a directory nobody established is inside the run root.
    const localDesktopRelay = spec.transport === 'relay' && this.localDesktopAuthority;
    // An adapter default is useful for readiness, pricing and direct CLI
    // execution, but is not an authored placement override. Relay harnesses
    // select their own default when the journaled step omitted `model`.
    const executionModel = spec.transport === 'relay' ? spec.model : effectiveModel;
    const cwd = agentStepCwd(localDesktopRelay ? { ...spec, transport: 'direct' } : spec,
      dispatch.step_id, this.options.runRoot);
    const completed: WorkerCliResult = await withWorkerLease(this.client, dispatch, signal =>
      'refusal' in cwd
        ? Promise.resolve({ exit_code: null, stdout_tail: '', stderr_tail: cwd.refusal })
        : typeof spec.cli === 'string' && typeof spec.instruction === 'string'
          ? runAgentCli(spec.cli, workerInstruction(spec.instruction, dispatch), dispatch.wake_context, executionModel, undefined, signal, 'agent', this.options.dataDir === undefined ? undefined : {
            dataDir: this.options.dataDir, runId: dispatch.run_id, stepId: dispatch.step_id, attempt: dispatch.attempt,
            onReady: this.options.onPtyReady, onDrive: () => { humanIntervention = true; },
          }, cwd.directory ?? (localDesktopRelay
            ? (this.options.runRoot ?? process.cwd())
            : (spec.transport === 'relay' ? undefined : this.options.runRoot)),
            spec.transport === 'relay' ? 'relay' : 'direct',
            { runId: dispatch.run_id, stepId: dispatch.step_id, idempotencyKey: dispatch.idempotency_key,
              attempt: dispatch.attempt, taskIdentity: workerInstructionIdentity(spec.instruction, dispatch),
              dataDir: this.options.dataDir, resultSchema: spec.verification?.json_schema,
              nodeSpawnRuntime: this.options.nodeSpawnRuntime,
              nodeSpawnRuntimeProvider: signal => this.nodeSpawnRuntimeOwner.get(signal),
              nodeSpawnCleanupPending: () => this.scheduleSettlementReconcile() },
            this.options.environment, spec.cli_identity, spec.timeout_ms, spec.resume, spec.secrets,
            this.client.supportsFeature?.('step_secret_scoping') ?? true)
          : Promise.resolve({ exit_code: null, stdout_tail: '', stderr_tail: 'agent step has no declared CLI' }));
    const { result, usage } = workerSpend(completed, executionModel);
    const cost = reportedCost(completed, executionModel);
    const completionReason = agentCompletionReason(result);

    // Output shape: if the CLI's stdout parses as JSON, promote THAT
    // as the step's `output` value so `json_schema` verification
    // validates the analysis payload, not a wrapper around stdout.
    // On the JSON path the CliResult (exit_code / stdout_tail /
    // stderr_tail) is DISCARDED from `output` — the schema author
    // wrote a shape for the analysis, not for the process wrapper.
    // Non-JSON stdout falls back to the wrapper so text-emitting
    // tools still round-trip usefully.
    //
    // Implicit contract: CLIs signal errors via non-zero exit, not by
    // emitting an error JSON with exit 0. `completionReason` is
    // derived from exit code, so a CLI that exits 0 while emitting
    // `{"error":...}` will report success with an error payload.
    //
    // `artifacts` (worker-cli.ts) rides inside the CliResult wrapper, so on
    // the wrapper path it is journaled in `output`, where the kernel's output
    // binding — and therefore an `artifact_exists` gate — can read it. On the
    // JSON path the author's object IS the output and is left exactly as the
    // agent emitted it: no key is added that a schema, a downstream binding
    // or `summary` never asked for. An agent that answers with a JSON object
    // therefore journals no artifacts; gate such a step on a deterministic
    // check instead. The relay transport reports none (the agent ran elsewhere).
    //
    // `transcript` is not part of the wrapper either: it is evidence about the
    // attempt, journaled in `trajectory_tail` below on success and failure
    // alike, where the kernel already accepts and bounds it (16 KiB).
    const { transcript, transport, relay_delivery: relayDelivery, ...rawWrapper } = result;
    // `stderr_tail` is evidence, not authored output. Redact and bound it
    // before it reaches either the worker-failure render or the journal --
    // against the environment the CLI ran with as well as this host's, since a
    // secret supplied only to the CLI is the one most likely to be echoed.
    const redacted = redactText(redactText(rawWrapper.stderr_tail), this.options.environment ?? process.env);
    const wrapper = {
      ...rawWrapper,
      stderr_tail: boundedTail(redacted, 2 * 1024, 'worker stderr: ').text,
    };
    const output = result.relay_task?.status === 'completed' && result.exit_code === 0
      ? result.relay_task.output : parseJsonOutput(result.stdout_tail) ?? wrapper;
    const trajectoryTail = {
      ...(result.relay_task === undefined ? {} : { relay_task: {
        invocation_id: result.relay_task.invocation_id, status: result.relay_task.status,
        task_execution: result.relay_task.task_execution, error: result.relay_task.error,
      } }),
      ...(transcript === undefined ? {} : { transcript: transcriptDigest(transcript, dispatch.attempt, result) }),
      ...(transport === undefined ? {} : { transport }),
    };

    await relayDelivery?.prepareSettlement?.({ attempt: dispatch.attempt, completionReason });
    await this.client.stepComplete(
      dispatch.run_id,
      dispatch.step_id,
      dispatch.attempt,
      dispatch.idempotency_key,
      completionReason,
      {
        output,
        ...(Object.keys(trajectoryTail).length === 0 ? {} : { trajectory_tail: trajectoryTail }),
        ...(humanIntervention ? { human_intervention: true } : {}),
        ...(usage !== undefined ? { usage } : {}),
        ...(cost === undefined ? {} : { reported_cost: cost }),
        started_pins: dispatch.pins,
        end_pins: completionReason === 'timeout'
          ? deadlineEndPins(dispatch.pins, result.workspace_stamp)
          : dispatch.pins,
      },
    );
    // Relay delivery is transport state, not execution truth. Only settle it
    // after the journal has accepted the attempt's terminal fact.
    await relayDelivery?.ack();
  }

  private reconcileRelaySettlementsAfterDrain(): Promise<void> {
    if (this.settlementDrain !== undefined) return this.settlementDrain;
    const generation = Array.from(this.inFlight);
    const running = (async () => {
      if (generation.length > 0) await Promise.allSettled(generation);
      await this.reconcileRelaySettlements();
    })();
    this.settlementDrain = running;
    void running.finally(() => {
      if (this.settlementDrain === running) this.settlementDrain = undefined;
    }).catch(() => undefined);
    return running;
  }

  private async reconcileRelaySettlements(): Promise<void> {
    if (this.settlementReconcile !== undefined) return this.settlementReconcile;
    const running = this.reconcileRelaySettlementsOnce();
    this.settlementReconcile = running;
    void running.finally(() => {
      if (this.settlementReconcile === running) this.settlementReconcile = undefined;
    }).catch(() => undefined);
    return running;
  }

  private async reconcileRelaySettlementsOnce(): Promise<void> {
    if (this.options.dataDir === undefined || (this.closing && !this.attached)) return;
    const claims = await readNodeSpawnClaims(this.options.dataDir);
    const hasPending = claims.some(entry => nodeSpawnCleanupRequired(entry.claim)
      || (entry.claim.result?.settlement !== undefined
        && entry.claim.result.settlement.settledAt === undefined));
    if (!hasPending) return;
    let runtime: NodeSpawnRuntime;
    try {
      runtime = await this.nodeSpawnRuntimeOwner.get();
    } catch (error) {
      this.scheduleSettlementReconcile();
      // A lazy remote worker cannot identify a pending claim's owner until its
      // runtime binds. A foreign claim or absent remote authority must not stop
      // an otherwise direct-only worker from attaching.
      if (!this.attached && !this.localDesktopAuthority) return;
      throw error;
    }
    let pending: number;
    try {
      pending = await reconcileNodeResultSettlements(this.options.dataDir, runtime, this.client);
    } catch (error) {
      this.scheduleSettlementReconcile();
      throw error;
    }
    if (this.settlementTimer !== undefined) {
      clearTimeout(this.settlementTimer);
      this.settlementTimer = undefined;
    }
    if (pending > 0) this.scheduleSettlementReconcile();
  }

  private scheduleSettlementReconcile(): void {
    if (this.closing || this.settlementTimer !== undefined) return;
    this.settlementTimer = setTimeout(() => {
      this.settlementTimer = undefined;
      void this.reconcileRelaySettlementsAfterDrain().catch(error => this.emit('error', error));
    }, 5_000);
    this.settlementTimer.unref();
  }

  private async retiredNodeSession(dispatch: StepDispatchEvent, error: string): Promise<void> {
    await withWorkerLease(this.client, dispatch, async signal => { signal.throwIfAborted(); });
    await this.client.stepComplete(
      dispatch.run_id, dispatch.step_id, dispatch.attempt, dispatch.idempotency_key,
      'worker_error', {
        output: { error },
        usage: { tokens_in: 0, tokens_out: 0, dollars_unmetered: true },
        started_pins: dispatch.pins,
        end_pins: dispatch.pins,
      },
    );
  }
}

/**
 * A deadline's end pin names the dirty tree the next attempt must inspect.
 * The stamp covers file contents and deletions, not the file bytes: the tail
 * is capped and the bytes stay on this worker's disk. An empty diff keeps
 * the start pin.
 */
function deadlineEndPins(pins: Pins, stamp: string | undefined): Pins {
  const workspace = pins.workspace ?? [];
  if (stamp === undefined || workspace.length === 0) return pins;
  if (workspace.every(pin => pin.revision_id === '')) return pins;
  return {
    ...pins,
    workspace: workspace.map(pin => pin.revision_id === ''
      ? pin
      : { ...pin, revision_id: `${pin.revision_id}+${stamp}` }),
  };
}

/**
 * The digest as journaled: the attempt and exit code (dropped from `output` on
 * the JSON path by design) and the artifact paths folded in, then bounded to
 * `TRANSCRIPT_DIGEST_MAX_BYTES` with every cut stated on the digest itself.
 */
function transcriptDigest(transcript: TranscriptDigest, attempt: number, result: WorkerCliResult): TranscriptDigest {
  return boundTranscriptDigest({
    attempt,
    exit_code: result.exit_code,
    ...transcript,
    ...(result.artifacts === undefined && (result.deleted === undefined || result.deleted.length === 0) ? {} : {
      artifacts: {
        count: result.artifacts?.length ?? 0,
        paths: (result.artifacts ?? []).slice(0, ARTIFACT_PATHS_MAX),
        ...(result.deleted === undefined || result.deleted.length === 0 ? {} : {
          deleted: result.deleted.slice(0, ARTIFACT_PATHS_MAX),
        }),
      },
    }),
  });
}

/**
 * Return an object-shaped JSON payload parsed from `stdout`, or
 * `null` when stdout is empty, non-JSON, or JSON-of-a-scalar/array.
 * The object-only restriction matches how `json_schema` gates are
 * authored — a scalar or array sneaking through would confuse both
 * the schema and downstream readers who expect field lookups on
 * `output`. Text-emitting tools and non-object JSON both fall
 * through to the CliResult wrapper preserved by the caller.
 */
export function parseJsonOutput(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim();
  if (trimmed === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  return parsed as Record<string, unknown>;
}
