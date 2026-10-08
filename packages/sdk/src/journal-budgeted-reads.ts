import { JournalFrameError, JournalProtocolError } from './journal-connection.js';
import type { JournalClient } from './journal-client.js';
import { JournalReadInterruptedError, JournalReadPolicy, JournalRequestTimeoutError } from './journal-read-policy.js';
import type { VerbContract } from './protocol.js';

/**
 * Budgeted, retried reads for one flow client, on a dedicated reader session.
 *
 * Reads go to a second connection so they never queue behind the primary's
 * unbounded commands; the policy serializes them and retries timeouts and lost
 * reader transport within the budget. Protocol refusals and malformed frames
 * fail closed. A refused reader handshake falls back to the primary session,
 * whose own failures keep their meaning because it also carries writes.
 */
export class BudgetedReads {
  private readonly policy = new JournalReadPolicy();
  private reader: JournalClient | undefined;
  private readerReady: Promise<JournalClient | undefined> | undefined;
  private readonly scoped = new Set<AbortSignal>();

  constructor(
    private readonly primary: JournalClient,
    private readonly budgetMs: number,
    private readonly lifecycle?: AbortSignal,
  ) {}

  /** Add an abort source (a root attempt's lease) for as long as the returned release is not called. */
  scope(signal: AbortSignal): () => void {
    this.scoped.add(signal);
    return () => { this.scoped.delete(signal); };
  }

  /**
   * Stop all reads. An unexpected primary drop (`interrupted`) ends in-flight
   * reads as a read interruption, so the run stays resumable; a caller close
   * keeps its plain error.
   */
  close(cause?: unknown, interrupted = false): void {
    this.policy.close(interrupted ? new JournalReadInterruptedError('journal', 1, 0, undefined, { cause }) : undefined);
    this.reader?.close(cause);
  }

  read<V extends keyof VerbContract>(verb: V, params: VerbContract[V]['params'], timeoutMs: number,
    signal?: AbortSignal): Promise<VerbContract[V]['result']> {
    const sources = [signal, this.lifecycle, ...this.scoped].filter((source): source is AbortSignal => source !== undefined);
    const combined = sources.length <= 1 ? sources[0] : AbortSignal.any(sources);
    return this.policy.read(verb, timeoutMs, this.budgetMs, async (bound, attemptSignal) => {
      const started = performance.now();
      const reader = await this.session().catch(error => {
        attemptSignal.throwIfAborted();
        // A malformed handshake frame is a protocol violation: fail closed.
        if (error instanceof JournalFrameError) throw error;
        throw new JournalReadInterruptedError(verb, 1, performance.now() - started, undefined, { cause: error });
      });
      attemptSignal.throwIfAborted();
      const remaining = bound - (performance.now() - started);
      if (remaining <= 0) throw new JournalRequestTimeoutError(verb, bound);
      if (reader === undefined) return this.primary.requestOnce(verb, params, remaining, attemptSignal);
      try {
        return await reader.requestOnce(verb, params, remaining, attemptSignal);
      } catch (error) {
        if (attemptSignal.aborted || error instanceof JournalRequestTimeoutError
          || error instanceof JournalProtocolError || error instanceof JournalFrameError) throw error;
        // Only the dedicated reader's transport failed; reconnect within the budget.
        this.drop(reader);
        throw new JournalReadInterruptedError(verb, 1, performance.now() - started, undefined, { cause: error });
      }
    }, combined);
  }

  /** The primary session's own `hello`, retried within the same budget as reads. */
  handshake(params: VerbContract['hello']['params'], timeoutMs: number): Promise<VerbContract['hello']['result']> {
    return this.policy.read('hello', timeoutMs, this.budgetMs,
      (bound, attemptSignal) => this.primary.requestOnce('hello', params, bound, attemptSignal), this.lifecycle);
  }

  private session(): Promise<JournalClient | undefined> {
    if (this.readerReady === undefined) {
      const reader = this.primary.createPeer();
      this.reader = reader;
      this.readerReady = reader.connect().then(() => reader.hello('flows-reader')).then(() => reader)
        .catch(error => {
          reader.close();
          // A daemon that refuses the session will keep refusing it: read on the primary.
          if (error instanceof JournalProtocolError) return undefined;
          // A connect or hello that failed under load is retried with a fresh session,
          // never by queueing reads behind the primary's unbounded commands for good.
          if (this.reader === reader) {
            this.reader = undefined;
            this.readerReady = undefined;
          }
          throw error;
        });
    }
    return this.readerReady;
  }

  /** Forget a reader whose transport failed so the next attempt reconnects one. */
  private drop(reader: JournalClient): void {
    if (this.reader !== reader) return;
    this.reader = undefined;
    this.readerReady = undefined;
    reader.close();
  }
}
