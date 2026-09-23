// Journal-protocol v0 client (kernel DESIGN.md §5).
//
// A real client implementation of the wire protocol — newline-delimited JSON
// over a unix socket. It correlates requests by `id`, demultiplexes
// server-pushed events, and is fail-closed: a connection drop or write error
// rejects every pending request (a journal write that fails fails the step;
// AGENTS.md rule 4). The kernel binary (`kernel/relayflowd serve`) speaks
// this transport, including out-of-band leases, watches, events, and durable
// stream plumbing. The client's framing and failure behavior is covered by a
// loopback double in tests.

import { EventEmitter } from 'node:events';
export { walkJournal, JournalReadError, type JournalEvent, type JournalReadFailure } from './journal-reader.js';
import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import type { VerbContract, EventEmitParams, EventSubmitParams } from './protocol.js';
import {
  PROTOCOL_VERSION,
  type CompletionReason,
  type EffectRef,
  type Pins,
  type Request,
  type Response,
  type ServerEvent,
  type StepUsage,
} from './protocol.js';
import type { KernelRunSpec, StepType } from './spec.js';

export interface JournalClientOptions {
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

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** A structured rejection returned by relayflowd over the journal protocol. */
export class JournalProtocolError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'JournalProtocolError';
    this.code = code;
  }
}

export class JournalClient extends EventEmitter {
  private socket: Socket | null = null;
  /** Why the connection ended, so a later "not connected" names its cause rather than hiding it. */
  private disconnectCause: Error | undefined;
  private buffer = '';
  private readonly pending = new Map<string, Pending>();
  private readonly requestTimeoutMs: number;
  private readonly connectTimeoutMs: number;

  constructor(
    readonly socketPath: string,
    options: JournalClientOptions = {},
  ) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
    this.connectTimeoutMs = options.connectTimeoutMs ?? 2_000;
  }

  /** Independent session for an SDK helper worker; preserves the caller's registration. */
  createPeer(): JournalClient {
    return new JournalClient(this.socketPath, {
      requestTimeoutMs: this.requestTimeoutMs, connectTimeoutMs: this.connectTimeoutMs,
    });
  }

  /** Open the unix socket connection. Rejects on connect failure (fail-closed). */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket) return resolve();
      const socket = createConnection({ path: this.socketPath });
      const timer = setTimeout(() => {
        socket.removeAllListeners();
        socket.destroy();
        this.failAll(new Error(`journal client: connect timed out after ${this.connectTimeoutMs}ms`));
        reject(new Error(`journal client: connect timed out after ${this.connectTimeoutMs}ms`));
      }, this.connectTimeoutMs);
      const onError = (err: Error): void => {
        clearTimeout(timer);
        socket.removeAllListeners();
        this.failAll(err);
        reject(new Error(`journal client: connect failed: ${err.message}`));
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        clearTimeout(timer);
        socket.removeListener('error', onError);
        socket.on('error', (err) => { this.disconnectCause ??= err; this.failAll(err); });
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('close', () => {
          const closed = new Error('journal client: connection closed');
          this.disconnectCause ??= closed;
          this.failAll(closed);
        });
        this.disconnectCause = undefined;
        this.socket = socket;
        resolve();
      });
    });
  }

  /**
   * Close the connection and reject any pending requests. A `cause` (for
   * example the worker failure that forced the close) is carried into every
   * later "not connected" rejection.
   */
  close(cause?: unknown): void {
    const closed = cause === undefined
      ? new Error('journal client: closed by caller')
      : new Error(`journal client: closed after ${cause instanceof Error ? cause.message : String(cause)}`, { cause });
    this.disconnectCause ??= closed;
    this.failAll(closed);
    this.socket?.destroy();
    this.socket = null;
    this.buffer = '';
  }

  private onData(chunk: Buffer): void {
    this.buffer += chunk.toString('utf8');
    let nl: number;
    while ((nl = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length > 0) this.onLine(line);
    }
  }

  private onLine(line: string): void {
    let msg: Response | ServerEvent;
    try {
      msg = JSON.parse(line) as Response | ServerEvent;
    } catch {
      // A malformed frame is a protocol violation; fail closed.
      this.failAll(new Error('journal client: malformed frame from server'));
      return;
    }

    if (typeof (msg as Response).id === 'string' && 'ok' in (msg as Response)) {
      const res = msg as Response;
      const pending = this.pending.get(res.id);
      if (!pending) return; // reply for an already-timed-out request
      this.pending.delete(res.id);
      if (pending.timer !== undefined) clearTimeout(pending.timer);
      if (res.ok) pending.resolve(res.result);
      else pending.reject(new JournalProtocolError(res.error.code, res.error.message));
    } else {
      const ev = msg as ServerEvent;
      this.emit(ev.event, ev.data);
      this.emit('event', ev);
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      if (p.timer !== undefined) clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private request<V extends keyof VerbContract>(
    verb: V,
    params: VerbContract[V]['params'],
    timeoutMs: number | null = this.requestTimeoutMs,
  ): Promise<VerbContract[V]['result']> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        const cause = this.disconnectCause;
        reject(new Error(
          `journal client: not connected (${verb})${cause === undefined ? '' : `: ${cause.message}`}`,
          cause === undefined ? undefined : { cause },
        ));
        return;
      }
      const id = randomUUID();
      const frame: Request = { id, verb: verb as string, params };
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`journal client: ${verb} timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.socket.write(JSON.stringify(frame) + '\n', (err) => {
        if (err) {
          const p = this.pending.get(id);
          if (p) {
            if (p.timer !== undefined) clearTimeout(p.timer);
            this.pending.delete(id);
            p.reject(new Error(`journal client: ${verb} write failed: ${err.message}`));
          }
        }
      });
    });
  }

  // --- Typed verb methods (gate 1 minimal set, kernel DESIGN.md §5) --------

  /** Handshake; version mismatch is a hard error. */
  hello(client: string): Promise<VerbContract['hello']['result']> {
    return this.request('hello', { protocol: PROTOCOL_VERSION, client });
  }

  /**
   * Validate a compiled kernel-dialect spec (zero-agent flows legal), create
   * the run file, and append `run.spawned`. Authoring specs must be compiled
   * with `toKernelSpec` before crossing this journal-protocol boundary.
   */
  runStart(spec: KernelRunSpec, reuseFromRunId?: string, admissionKey?: string): Promise<VerbContract['run.start']['result']> {
    return this.request('run.start', {
      spec,
      ...(reuseFromRunId === undefined ? {} : { reuse_from_run_id: reuseFromRunId }),
      ...(admissionKey === undefined ? {} : { admission_key: admissionKey }),
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
  runGet(runId: string): Promise<VerbContract['run.get']['result']> {
    return this.request('run.get', { run_id: runId });
  }

  /**
   * Open a push stream of every appended entry. Resolves once subscribed;
   * entries arrive as `'entry'` events: `client.on('entry', (entry) => …)`.
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
    } = {},
  ): Promise<VerbContract['step.complete']['result']> {
    return this.request('step.complete', {
      run_id: runId,
      step_id: stepId,
      attempt,
      idempotency_key: idempotencyKey,
      completionReason,
      ...extra,
    }, null);
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
