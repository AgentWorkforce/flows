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

/** Serial admission bounds read amplification, including retries, per body client. */
export class JournalReadPolicy {
  private tail: Promise<unknown> = Promise.resolve();
  private readonly closed = new AbortController();

  constructor() {
    // Concurrent children share this cancellation signal; each waiter removes its listener.
    setMaxListeners(0, this.closed.signal);
  }

  close(): void { this.closed.abort(new Error('journal client: closed by caller')); }

  async read<T>(verb: string, timeoutMs: number, budgetMs: number,
    request: (timeoutMs: number) => Promise<T>): Promise<T> {
    const started = performance.now();
    const deadline = started + budgetMs;
    let attempts = 0;
    const exhausted = () => new JournalRequestTimeoutError(verb, timeoutMs, attempts,
      performance.now() - started, budgetMs);
    const signal = this.closed.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onClose: () => void = () => {};
    let deliver: (value: T) => void = () => {};
    let fail: (error: unknown) => void = () => {};
    const response = new Promise<T>((resolve, reject) => {
      deliver = resolve;
      fail = reject;
      timer = setTimeout(() => reject(exhausted()), budgetMs);
      onClose = () => reject(signal.reason);
      signal.addEventListener('abort', onClose, { once: true });
      if (signal.aborted) onClose();
    });
    const job = this.tail.then(async () => {
      while (true) {
        signal.throwIfAborted();
        const remaining = deadline - performance.now();
        if (remaining <= 0) throw exhausted();
        attempts += 1;
        try {
          return await request(Math.min(remaining, timeoutMs * 2 ** Math.max(0, attempts - 2)));
        } catch (error) {
          if (!(error instanceof JournalRequestTimeoutError)) throw error;
          const left = deadline - performance.now();
          if (left <= 0) throw exhausted();
          // Jitter plus escalating bounds keep a slow daemon from collecting a retry storm.
          await sleep(Math.min(left, Math.min(1000, timeoutMs / 4) * (0.5 + Math.random())), undefined, { signal });
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
