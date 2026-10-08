import { setMaxListeners } from 'node:events';
import { setTimeout as sleep } from 'node:timers/promises';

export const READ_ONLY_VERBS = new Set(['run.get', 'journal.read', 'stream.read', 'subscription.inspect']);
export const FLOW_READ_BUDGET_MS = 300_000;

export class JournalRequestTimeoutError extends Error {
  constructor(
    readonly verb: string,
    readonly timeoutMs: number,
    readonly attempts = 1,
    readonly elapsedMs = timeoutMs,
    readonly readBudgetMs?: number,
  ) {
    super(readBudgetMs === undefined
      ? `journal client: ${verb} timed out after ${timeoutMs}ms`
      : `journal client: ${verb} timed out after ${attempts} attempts in ${Math.round(elapsedMs)}ms (read budget ${readBudgetMs}ms); relayflowd may be delayed by CPU load`);
    this.name = 'JournalRequestTimeoutError';
  }
}

/**
 * The dedicated read session lost its transport (closed, reset, not connected)
 * while the primary session may still be healthy. Like a timeout, this says
 * nothing about the run itself: retry within the budget, then leave the run
 * resumable. Protocol refusals and write failures are never this error.
 */
export class JournalReadInterruptedError extends Error {
  constructor(
    readonly verb: string,
    readonly attempts = 1,
    readonly elapsedMs = 0,
    readonly readBudgetMs?: number,
    options?: ErrorOptions & { retryable?: boolean },
  ) {
    const cause = options?.cause instanceof Error ? `: ${options.cause.message}` : '';
    super(readBudgetMs === undefined
      ? `journal client: ${verb} read session was interrupted${cause}`
      : `journal client: ${verb} read session was interrupted after ${attempts} attempts in ${Math.round(elapsedMs)}ms (read budget ${readBudgetMs}ms)${cause}`,
    options);
    this.name = 'JournalReadInterruptedError';
    this.retryable = options?.retryable !== false;
  }

  /** False when the session it ran on is gone, so retrying it cannot help. */
  readonly retryable: boolean;
}

/** A read that could not be answered — by timeout or lost read transport — not a run failure. */
export function isReadInterruptionError(error: unknown): error is JournalRequestTimeoutError | JournalReadInterruptedError {
  return (error instanceof JournalRequestTimeoutError
    && (READ_ONLY_VERBS.has(error.verb) || error.verb === 'run.watch' || error.verb === 'hello'))
    || error instanceof JournalReadInterruptedError;
}

/** Serial admission bounds read amplification, including retries, per body client. */
export class JournalReadPolicy {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly closed = new AbortController();

  constructor() {
    // Concurrent children share this cancellation signal; each waiter removes its listener.
    setMaxListeners(0, this.closed.signal);
  }

  close(reason: unknown = new Error('journal client: closed by caller')): void { this.closed.abort(reason); }

  async read<T>(verb: string, timeoutMs: number, budgetMs: number,
    request: (timeoutMs: number, signal: AbortSignal) => Promise<T>, caller?: AbortSignal): Promise<T> {
    const started = performance.now();
    const deadline = started + budgetMs;
    let attempts = 0;
    let last: unknown;
    const exhausted = () => last instanceof JournalReadInterruptedError
      ? new JournalReadInterruptedError(verb, attempts, performance.now() - started, budgetMs, { cause: last.cause })
      : new JournalRequestTimeoutError(verb, timeoutMs, attempts, performance.now() - started, budgetMs);
    // A caller's cancellation settles this read and drains its queued attempt.
    const signal = caller === undefined ? this.closed.signal : AbortSignal.any([this.closed.signal, caller]);
    // Budget exhaustion also aborts the queued work, so a stalled setup or
    // request does not hold the serialized queue after its caller gave up.
    const budget = new AbortController();
    const attemptSignal = AbortSignal.any([signal, budget.signal]);
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onClose: () => void = () => {};
    let deliver: (value: T) => void = () => {};
    let fail: (error: unknown) => void = () => {};
    const response = new Promise<T>((resolve, reject) => {
      deliver = resolve;
      fail = reject;
      timer = setTimeout(() => { const error = exhausted(); budget.abort(error); reject(error); }, budgetMs);
      onClose = () => reject(signal.reason);
      signal.addEventListener('abort', onClose, { once: true });
      if (signal.aborted) onClose();
    });
    const job = this.tail.then(async () => {
      while (true) {
        attemptSignal.throwIfAborted();
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw exhausted();
        attempts += 1;
        try {
          return await request(Math.min(remaining, timeoutMs * 2 ** Math.max(0, attempts - 2)), attemptSignal);
        } catch (error) {
          attemptSignal.throwIfAborted();
          if (!(error instanceof JournalRequestTimeoutError
            || (error instanceof JournalReadInterruptedError && error.retryable))) throw error;
          last = error;
          const left = deadline - performance.now();
          if (left <= 0) throw exhausted();
          // Jitter plus escalating bounds keep a slow daemon from collecting a retry storm.
          await sleep(Math.min(left, Math.min(1000, timeoutMs / 4) * (0.5 + Math.random())), undefined, { signal: attemptSignal });
        }
      }
    });
    this.tail = job.catch(() => {});
    void job.then(deliver, fail);
    try { return await response; }
    finally {
      clearTimeout(timer);
      signal.removeEventListener('abort', onClose);
    }
  }
}
