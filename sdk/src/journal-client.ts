// Journal-protocol v0 client (kernel DESIGN.md §5).
//
// A real client implementation of the wire protocol — newline-delimited JSON
// over a unix socket. It correlates requests by `id`, demultiplexes
// server-pushed events, and is fail-closed: a connection drop or write error
// rejects every pending request (a journal write that fails fails the step;
// AGENTS.md rule 4). The kernel binary (`kernel/relayflowd serve`) speaks
// this transport; its gate-1 rung serves `hello`, `run.start`, `run.resume`,
// `run.get`, and `journal.read`, and rejects the remaining typed verbs
// explicitly. The client's own framing and failure behavior is covered by a
// loopback double in tests.

import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import type { VerbContract } from './protocol.js';
import {
  PROTOCOL_VERSION,
  type CompletionReason,
  type Request,
  type Response,
  type ServerEvent,
} from './protocol.js';
import { toKernelSpec } from './compile.js';
import type { FlowSpec, StepType } from './spec.js';

export interface JournalClientOptions {
  /** Override the per-request timeout (ms). Default 30000. */
  requestTimeoutMs?: number;
}

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class JournalClient extends EventEmitter {
  private socket: Socket | null = null;
  private buffer = '';
  private readonly pending = new Map<string, Pending>();
  private readonly requestTimeoutMs: number;

  constructor(
    private readonly socketPath: string,
    options: JournalClientOptions = {},
  ) {
    super();
    this.requestTimeoutMs = options.requestTimeoutMs ?? 30_000;
  }

  /** Open the unix socket connection. Rejects on connect failure (fail-closed). */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket) return resolve();
      const socket = createConnection({ path: this.socketPath });
      const onError = (err: Error): void => {
        socket.removeAllListeners();
        this.failAll(err);
        reject(new Error(`journal client: connect failed: ${err.message}`));
      };
      socket.once('error', onError);
      socket.once('connect', () => {
        socket.removeListener('error', onError);
        socket.on('error', (err) => this.failAll(err));
        socket.on('data', (chunk) => this.onData(chunk));
        socket.on('close', () => this.failAll(new Error('journal client: connection closed')));
        this.socket = socket;
        resolve();
      });
    });
  }

  /** Close the connection and reject any pending requests. */
  close(): void {
    this.failAll(new Error('journal client: closed by caller'));
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
      clearTimeout(pending.timer);
      if (res.ok) pending.resolve(res.result);
      else pending.reject(new Error(`${res.error.code}: ${res.error.message}`));
    } else {
      const ev = msg as ServerEvent;
      this.emit(ev.event, ev.data);
      this.emit('event', ev);
    }
  }

  private failAll(err: Error): void {
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }

  private request<V extends keyof VerbContract>(
    verb: V,
    params: VerbContract[V]['params'],
  ): Promise<VerbContract[V]['result']> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        reject(new Error(`journal client: not connected (${verb})`));
        return;
      }
      const id = randomUUID();
      const frame: Request = { id, verb: verb as string, params };
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`journal client: ${verb} timed out after ${this.requestTimeoutMs}ms`));
      }, this.requestTimeoutMs);
      this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject, timer });
      this.socket.write(JSON.stringify(frame) + '\n', (err) => {
        if (err) {
          const p = this.pending.get(id);
          if (p) {
            clearTimeout(p.timer);
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
   * Validate spec (zero-agent flows legal), create run file, append
   * `run.spawned`. Takes the authoring `FlowSpec` and converts it to the
   * kernel dialect at the boundary (`toKernelSpec`): the kernel's
   * `RunSpec::parse` is fail-closed and rejects authoring keys like
   * `maxIterations`/`dependsOn`, so sending the authoring shape verbatim
   * could never start a run.
   */
  runStart(spec: FlowSpec): Promise<VerbContract['run.start']['result']> {
    return this.request('run.start', { spec: toKernelSpec(spec) });
  }

  /** §3 memoized resume. */
  runResume(runId: string): Promise<VerbContract['run.resume']['result']> {
    return this.request('run.resume', { run_id: runId });
  }

  /** Snapshot for legibility. */
  runGet(runId: string): Promise<VerbContract['run.get']['result']> {
    return this.request('run.get', { run_id: runId });
  }

  /**
   * Open a push stream of every appended entry. Resolves once subscribed;
   * entries arrive as `'entry'` events: `client.on('entry', (entry) => …)`.
   */
  runWatch(runId: string): Promise<void> {
    return this.request('run.watch', { run_id: runId });
  }

  /** Connection becomes a worker; receives `step.dispatch` events. */
  workerAttach(workerId: string, stepTypes: StepType[]): Promise<void> {
    return this.request('worker.attach', { worker_id: workerId, step_types: stepTypes });
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

  /** Complete a dispatched step — also the out-of-band path. */
  stepComplete(
    runId: string,
    stepId: string,
    attempt: number,
    idempotencyKey: string,
    completionReason: CompletionReason,
    extra: {
      output?: unknown;
      usage?: { tokens_in: number; tokens_out: number; dollars: string };
      end_pins?: {
        workspace?: { surface: string; revision_id: string }[];
        streams?: { stream: string; read_offset: number }[];
      };
    } = {},
  ): Promise<void> {
    return this.request('step.complete', {
      run_id: runId,
      step_id: stepId,
      attempt,
      idempotency_key: idempotencyKey,
      completionReason,
      ...extra,
    });
  }

  /** Satisfy `wait.event`; a human response arrives here too. */
  eventEmit(runId: string, eventKey: string, payload: unknown): Promise<VerbContract['event.emit']['result']> {
    return this.request('event.emit', { run_id: runId, event_key: eventKey, payload });
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
