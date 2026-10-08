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
import { randomUUID } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';
import { JournalRequestTimeoutError } from './journal-read-policy.js';
import type { Request, Response, ServerEvent, VerbContract } from './protocol.js';

interface Pending {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** A structured rejection returned by relayflowd over the journal protocol. */
export class JournalProtocolError extends Error {
  readonly code: string;
  verb?: string;

  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'JournalProtocolError';
    this.code = code;
  }
}

/** The daemon sent a frame this client cannot parse: a protocol violation, never retried. */
export class JournalFrameError extends Error {
  constructor(message = 'journal client: malformed frame from server') {
    super(message);
    this.name = 'JournalFrameError';
  }
}

/** Framing, socket lifecycle and request correlation; the typed verbs live on JournalClient. */
export class JournalConnection extends EventEmitter {
  protected socket: Socket | null = null;
  private connectingSocket: Socket | undefined;
  /** Why the connection ended, so a later "not connected" names its cause rather than hiding it. */
  protected disconnectCause: Error | undefined;
  private buffer = '';
  private readonly pending = new Map<string, Pending>();

  constructor(
    readonly socketPath: string,
    protected readonly requestTimeoutMs: number,
    protected readonly connectTimeoutMs: number,
  ) {
    super();
  }

  /** Hook for sessions layered on this one: `unexpected` is a drop the caller did not ask for. */
  protected connectionClosed(_cause: unknown, _unexpected: boolean): void {}

  /** Open the unix socket connection. Rejects on connect failure (fail-closed). */
  connect(): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.socket) return resolve();
      const socket = createConnection({ path: this.socketPath });
      this.connectingSocket = socket;
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
          this.connectionClosed(closed, this.socket === socket);
          this.disconnectCause ??= closed;
          this.failAll(closed);
          // Only a drop the caller did not ask for; close() clears this.socket first.
          // Sessions with nothing pending (a registered watch) must hear it too.
          if (this.socket === socket) this.emit('disconnected', closed);
        });
        this.disconnectCause = undefined;
        this.connectingSocket = undefined;
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
    this.connectionClosed(cause, false);
    this.connectingSocket?.destroy(closed);
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
      const error = new JournalFrameError();
      this.failAll(error);
      // Sessions with nothing pending (a registered watch) must hear it too.
      this.emit('protocol_error', error);
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

  /** @internal One unretried request on this session; flow reads go through `request`. */
  requestOnce<V extends keyof VerbContract>(
    verb: V,
    params: VerbContract[V]['params'],
    timeoutMs: number | null = this.requestTimeoutMs,
    signal?: AbortSignal,
  ): Promise<VerbContract[V]['result']> {
    return new Promise((resolve, reject) => {
      if (signal?.aborted) {
        reject(signal.reason);
        return;
      }
      if (!this.socket || this.socket.destroyed) {
        const cause = this.disconnectCause;
        reject(new Error(
          `journal client: not connected (${verb})${cause === undefined ? '' : `: ${cause.message}`}`,
          cause === undefined ? undefined : { cause },
        ));
        return;
      }
      const id = randomUUID();
      const started = performance.now();
      const frame: Request = { id, verb: verb as string, params };
      // Cancellation forgets the request; a late reply is ignored like a timed-out one.
      const onAbort = () => {
        const p = this.pending.get(id);
        if (p === undefined) return;
        if (p.timer !== undefined) clearTimeout(p.timer);
        this.pending.delete(id);
        p.reject(signal!.reason);
      };
      const settle = <A>(fn: (arg: A) => void) => (arg: A) => {
        signal?.removeEventListener('abort', onAbort);
        fn(arg);
      };
      const timer = timeoutMs === null ? undefined : setTimeout(() => {
        this.pending.delete(id);
        settle(reject)(new JournalRequestTimeoutError(verb, timeoutMs, 1, performance.now() - started));
      }, timeoutMs);
      this.pending.set(id, { resolve: settle(resolve as (v: unknown) => void), reject: settle(reject), timer });
      signal?.addEventListener('abort', onAbort, { once: true });
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
}
