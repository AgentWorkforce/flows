// Journal-protocol v0 client (kernel DESIGN.md §5).
//
// A real client implementation of the wire protocol — newline-delimited JSON
// over a unix socket. It correlates requests by `id`, demultiplexes
// server-pushed events, and is fail-closed: a connection drop or write error
// rejects every pending request (a journal write that fails fails the step;
// AGENTS.md rule 4). The kernel binary (`kernel/relayflowd serve`) speaks
// this transport, including out-of-band leases, watches, events, and durable
// stream plumbing. The client's framing and failure behavior is covered by a
// loopback double in tests. Framing and the socket lifecycle live in
// journal-connection.ts; budgeted reads in journal-budgeted-reads.ts.

import { READ_ONLY_VERBS } from './journal-read-policy.js';
import { JournalConnection, JournalProtocolError } from './journal-connection.js';
export { JournalFrameError, JournalProtocolError } from './journal-connection.js';
import { BudgetedReads } from './journal-budgeted-reads.js';
export { JournalReadInterruptedError, JournalRequestTimeoutError } from './journal-read-policy.js';
export { walkJournal, JournalReadError, type JournalEvent, type JournalReadFailure } from './journal-reader.js';
import type { VerbContract, EventEmitParams, EventSubmitParams, ReportedCost } from './protocol.js';
import {
  PROTOCOL_VERSION,
  type CompletionReason,
  type EffectRef,
  type Pins,
  type StepUsage,
} from './protocol.js';
import type { KernelRunSpec, StepType } from './spec.js';

export interface JournalClientOptions {
  /** Opt-in total budget for read-only requests; interactive clients stay single-shot. */
  readBudgetMs?: number;
  /** Cancels every budgeted read, so a run's lifecycle abort never waits out the budget. */
  readSignal?: AbortSignal;
  /**
   * Retry this session's own `hello` within the read budget. Only for sessions
   * opened after a run is admitted (an authored child, its verifier); a
   * top-level command's handshake stays a single-shot compatibility check.
   */
  budgetHandshake?: boolean;
  /** Override the timeout for bounded protocol requests (ms). Default 30000. */
  requestTimeoutMs?: number;
  /**
   * Bound on `connect()` (ms). Default 2000.
   *
   * `connect()` used to have no timer at all, which was survivable while the
   * only caller was a command that had already decided a daemon was there.
   * `daemon-lifecycle.ts` probes the socket before every command, and a
   * listener that accepts but never answers would otherwise hold the CLI for
   * the 30s request default before it could decide to spawn
   * (kernel/DAEMON-LIFECYCLE.md §4).
   */
  connectTimeoutMs?: number;
}

export class JournalClient extends JournalConnection {
  private readonly budgeted: BudgetedReads | undefined;
  private readonly budgetHandshake: boolean;
  /** Additive request capabilities the daemon advertised at `hello`; none until then. */
  private features: ReadonlySet<string> = new Set();

  constructor(socketPath: string, options: JournalClientOptions = {}) {
    super(socketPath, options.requestTimeoutMs ?? 30_000, options.connectTimeoutMs ?? 2_000);
    this.budgetHandshake = options.budgetHandshake === true;
    this.budgeted = options.readBudgetMs === undefined ? undefined
      : new BudgetedReads(this, options.readBudgetMs, options.readSignal);
  }

  protected override connectionClosed(cause: unknown, unexpected: boolean): void {
    this.budgeted?.close(cause, unexpected);
  }

  /** Independent session for an SDK helper worker; preserves the caller's registration. */
  createPeer(): JournalClient {
    return new JournalClient(this.socketPath, {
      requestTimeoutMs: this.requestTimeoutMs, connectTimeoutMs: this.connectTimeoutMs,
    });
  }

  private request<V extends keyof VerbContract>(verb: V, params: VerbContract[V]['params'],
    timeoutMs: number | null = this.requestTimeoutMs, signal?: AbortSignal): Promise<VerbContract[V]['result']> {
    // Every allowlisted read takes the policy, even after the primary dropped: its
    // closed state then answers with the typed interruption recorded at the drop.
    if (this.budgeted !== undefined && timeoutMs !== null && READ_ONLY_VERBS.has(verb)) {
      return this.budgeted.read(verb, params, timeoutMs, signal);
    }
    return this.requestOnce(verb, params, timeoutMs, signal);
  }

  /**
   * Cancel budgeted reads also when `signal` aborts — a root attempt's lease —
   * until the returned release is called. A no-op without a read budget.
   */
  scopeReads(signal: AbortSignal): () => void {
    return this.budgeted?.scope(signal) ?? (() => {});
  }

  /** End every budgeted read now and refuse later ones; the session itself stays open. */
  cancelReads(): void {
    this.budgeted?.close(new Error('journal client: reads canceled'));
  }

  // --- Typed verb methods (gate 1 minimal set, kernel DESIGN.md §5) --------

  /** Handshake; version mismatch is a hard error. Records the daemon's additive features. */
  async hello(client: string): Promise<VerbContract['hello']['result']> {
    const params = { protocol: PROTOCOL_VERSION, client };
    // A flow client's handshake meets the same CPU load as its reads.
    const result = this.budgeted === undefined || !this.budgetHandshake ? await this.request('hello', params)
      : await this.budgeted.handshake(params, this.requestTimeoutMs);
    this.features = new Set(Array.isArray(result.features) ? result.features.filter(f => typeof f === 'string') : []);
    return result;
  }

  /**
   * Validate a compiled kernel-dialect spec (zero-agent flows legal), create
   * the run file, and append `run.spawned`. Authoring specs must be compiled
   * with `toKernelSpec` before crossing this journal-protocol boundary.
   * `watch` streams the run's entries as `'entry'` events while it runs.
   */
  runStart(
    spec: KernelRunSpec,
    reuseFromRunId?: string,
    admissionKey?: string,
    watch = false,
  ): Promise<VerbContract['run.start']['result']> {
    return this.request('run.start', {
      spec,
      ...(reuseFromRunId === undefined ? {} : { reuse_from_run_id: reuseFromRunId }),
      ...(admissionKey === undefined ? {} : { admission_key: admissionKey }),
      ...(watch ? { watch: true } : {}),
    }, null);
  }

  /** §3 memoized resume. */
  runResume(runId: string, allowHumanInfluenced = false): Promise<VerbContract['run.resume']['result']> {
    return this.request('run.resume', { run_id: runId, ...(allowHumanInfluenced ? { allow_human_influenced: true } : {}) }, null);
  }

  /** Durably request cancellation and return the terminal run fact. */
  runCancel(runId: string): Promise<VerbContract['run.cancel']['result']> {
    return this.request('run.cancel', { run_id: runId }, null);
  }

  /** Snapshot for legibility. */
  runGet(runId: string, options: { signal?: AbortSignal } = {}): Promise<VerbContract['run.get']['result']> {
    return this.request('run.get', { run_id: runId }, this.requestTimeoutMs, options.signal);
  }

  /**
   * Open a push stream of every appended entry. The daemon writes the run's
   * existing entries before this resolves (server.rs `watch_with_replay`), so
   * the replay is fully delivered first; later entries arrive as they are
   * appended. Entries arrive as `'entry'` events: `client.on('entry', (entry) => …)`.
   */
  runWatch(runId: string): Promise<VerbContract['run.watch']['result']> {
    return this.request('run.watch', { run_id: runId });
  }

  /** Connection becomes a worker; receives `step.dispatch` events. */
  workerAttach(workerId: string, stepTypes: StepType[], pins?: Pins, capacity?: number, requiredStreams?: string[]): Promise<VerbContract['worker.attach']['result']> {
    return this.request('worker.attach', { worker_id: workerId, step_types: stepTypes, pins, capacity, required_streams: requiredStreams });
  }

  /**
   * Phase one of the writeback protocol (Appendix A rule 5): ask the journal to
   * elect this attempt to perform the effect. **Do not call this directly to
   * perform an effect** — use {@link performEffect}, which cannot leave the
   * election and the provider call separated. A `false` here means this attempt
   * owes the provider call *and* the {@link effectConfirm} that closes it;
   * returning from `effectRecord` without doing both leaves the election open.
   */
  effectRecord(
    runId: string,
    stepId: string,
    attempt: number,
    idempotencyKey: string,
    surfacePath: string,
    revisionBefore: string,
    revisionAfter: string,
  ): Promise<VerbContract['effect.record']['result']> {
    return this.request('effect.record', {
      run_id: runId,
      step_id: stepId,
      attempt,
      idempotency_key: idempotencyKey,
      surface_path: surfacePath,
      revision_before: revisionBefore,
      revision_after: revisionAfter,
    });
  }

  /**
   * Phase two: the provider call this attempt was elected for has happened.
   * Confirming closes the election so no later attempt reclaims it. Only the
   * attempt holding the election may confirm it; the kernel refuses anything
   * else.
   */
  effectConfirm(
    runId: string,
    stepId: string,
    attempt: number,
    idempotencyKey: string,
    surfacePath: string,
  ): Promise<VerbContract['effect.confirm']['result']> {
    return this.request('effect.confirm', {
      run_id: runId,
      step_id: stepId,
      attempt,
      idempotency_key: idempotencyKey,
      surface_path: surfacePath,
    });
  }

  /**
   * Perform one declared external effect exactly once: elect, perform, confirm.
   *
   * Election alone is not a promise that the writeback happened — a worker that
   * dies between `effect.record` and its provider call would otherwise leave a
   * winner nothing ever performed, and every retry would skip the call while
   * the run completed as if the effect had occurred. Holding the three phases
   * inside one call is what makes them inseparable at this boundary: `perform`
   * runs only for the attempt that won the election, and the election is closed
   * only after `perform` returns. A `perform` that throws leaves the election
   * unconfirmed and therefore reclaimable, so the next attempt performs it.
   *
   * Returns whether this attempt made the provider call; `false` means a
   * confirmed election already covered it.
   */
  async performEffect(
    effect: {
      runId: string;
      stepId: string;
      attempt: number;
      idempotencyKey: string;
      surfacePath: string;
      revisionBefore: string;
      revisionAfter: string;
    },
    perform: () => Promise<void>,
  ): Promise<boolean> {
    const { deduped } = await this.effectRecord(
      effect.runId,
      effect.stepId,
      effect.attempt,
      effect.idempotencyKey,
      effect.surfacePath,
      effect.revisionBefore,
      effect.revisionAfter,
    );
    if (deduped) return false;
    await perform();
    await this.effectConfirm(
      effect.runId,
      effect.stepId,
      effect.attempt,
      effect.idempotencyKey,
      effect.surfacePath,
    );
    return true;
  }

  /** Renew the lease — the one lease primitive. */
  stepHeartbeat(
    runId: string,
    stepId: string,
    attempt: number,
    leaseId: string,
  ): Promise<VerbContract['step.heartbeat']['result']> {
    return this.request('step.heartbeat', {
      run_id: runId,
      step_id: stepId,
      attempt,
      lease_id: leaseId,
    }).catch(error => {
      if (error instanceof JournalProtocolError) error.verb = 'step.heartbeat';
      throw error;
    });
  }

  /**
   * Complete a dispatched step — also the out-of-band path. Like runStart
   * and runResume, this drives downstream steps before replying, so their
   * execution bounds apply rather than the bounded protocol-request timeout.
   */
  stepComplete(
    runId: string,
    stepId: string,
    attempt: number,
    idempotencyKey: string,
    completionReason: CompletionReason,
    extra: {
      output?: unknown;
      usage?: StepUsage;
      started_pins?: Pins;
      end_pins?: Pins;
      effects?: EffectRef[];
      trajectory_tail?: unknown;
      human_intervention?: boolean;
      reported_cost?: ReportedCost;
    } = {},
  ): Promise<VerbContract['step.complete']['result']> {
    // `reported_cost` is display-only, and a daemon that predates it refuses
    // unknown completion fields: drop it rather than fail the completion.
    const { reported_cost: reportedCost, ...rest } = extra;
    return this.request('step.complete', {
      run_id: runId,
      step_id: stepId,
      attempt,
      idempotency_key: idempotencyKey,
      completionReason,
      ...rest,
      ...(reportedCost !== undefined && this.features.has('reported_cost') ? { reported_cost: reportedCost } : {}),
    }, null).catch(error => {
      if (error instanceof JournalProtocolError) error.verb = 'step.complete';
      throw error;
    });
  }

  /** Satisfy `wait.event`; a human response arrives here too. */
  /**
   * Park the dispatched attempt this connection holds on a human question.
   * Releases the lease; the caller must not heartbeat or complete afterwards.
   */
  stepWait(
    runId: string,
    stepId: string,
    attempt: number,
    idempotencyKey: string,
    wait: { wait_id: string; prompt: string; requested_of: string; options?: string[]; timeout_at_ms?: number },
  ): Promise<VerbContract['step.wait']['result']> {
    return this.request('step.wait', {
      run_id: runId,
      step_id: stepId,
      attempt,
      idempotency_key: idempotencyKey,
      ...wait,
    }).catch(error => {
      if (error instanceof JournalProtocolError) error.verb = 'step.wait';
      throw error;
    });
  }

  eventEmit(
    runId: string,
    eventKey: string,
    payload: unknown,
    options: Pick<EventEmitParams, 'delivery_id' | 'actor'> = {},
  ): Promise<VerbContract['event.emit']['result']> {
    return this.request('event.emit', { run_id: runId, event_key: eventKey, payload, ...options });
  }

  subscriptionPark(params: VerbContract['subscription.park']['params']): Promise<VerbContract['subscription.park']['result']> {
    return this.request('subscription.park', params);
  }

  /**
   * Submit an external event to a flow that declares an event trigger.
   *
   * Without this wrapper the verb existed on the server but was unreachable
   * through the typed client, so authors had to bypass the protocol surface
   * entirely to use the feature.
   */
  eventSubmit(spec: unknown, event: EventSubmitParams['event']): Promise<VerbContract['event.submit']['result']> {
    return this.request('event.submit', { spec, event });
  }

  /** Prepare a body subscription. Cloud must activate the returned request before a body can observe it. */
  subscriptionOpen(params: VerbContract['subscription.open']['params']): Promise<VerbContract['subscription.open']['result']> {
    return this.request('subscription.open', params, null);
  }

  /** Commit Cloud's durable binding receipt and ingress fence. */
  subscriptionActivate(params: VerbContract['subscription.activate']['params']): Promise<VerbContract['subscription.activate']['result']> {
    return this.request('subscription.activate', params, null);
  }

  /** Append to one activated subscription under its immutable router receipt. */
  subscriptionDeliver(params: VerbContract['subscription.deliver']['params']): Promise<VerbContract['subscription.deliver']['result']> {
    return this.request('subscription.deliver', params, null);
  }

  /** Read durable subscription state without changing timers or ingress. */
  subscriptionInspect(params: VerbContract['subscription.inspect']['params']): Promise<VerbContract['subscription.inspect']['result']> {
    return this.request('subscription.inspect', params);
  }

  /** Fence the exact activated receipt after router-side overflow. */
  subscriptionFenceOverflow(params: VerbContract['subscription.fence_overflow']['params']): Promise<VerbContract['subscription.fence_overflow']['result']> {
    return this.request('subscription.fence_overflow', params, null);
  }

  /** Return a durable wake, or an explicit suspension with no daemon-side sleep. */
  subscriptionNext(params: VerbContract['subscription.next']['params']): Promise<VerbContract['subscription.next']['result']> {
    return this.request('subscription.next', params, null);
  }

  /** Close a body subscription; the server refuses later external appends. */
  subscriptionClose(params: VerbContract['subscription.close']['params']): Promise<VerbContract['subscription.close']['result']> {
    return this.request('subscription.close', params, null);
  }

  channelAppend(params: VerbContract['channel.append']['params']): Promise<VerbContract['channel.append']['result']> {
    return this.request('channel.append', params);
  }
  channelReceive(params: VerbContract['channel.receive']['params']): Promise<VerbContract['channel.receive']['result']> {
    return this.request('channel.receive', params);
  }
  channelAck(params: VerbContract['channel.ack']['params']): Promise<VerbContract['channel.ack']['result']> {
    return this.request('channel.ack', params);
  }

  /** Durable channel write; journals `stream.appended`. */
  streamAppend(runId: string, stream: string, message: unknown): Promise<VerbContract['stream.append']['result']> {
    return this.request('stream.append', { run_id: runId, stream, message });
  }

  /** At-least-once replayable read. Committing the consumer offset happens via pins. */
  streamRead(runId: string, stream: string, fromOffset: number, limit?: number): Promise<VerbContract['stream.read']['result']> {
    return this.request('stream.read', { run_id: runId, stream, from_offset: fromOffset, limit });
  }

  /** Raw journal access — replay, audit, the report step. */
  journalRead(runId: string, fromSeq: number, limit?: number): Promise<VerbContract['journal.read']['result']> {
    return this.request('journal.read', { run_id: runId, from_seq: fromSeq, limit });
  }
}
