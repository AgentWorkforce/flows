/**
 * Sleep that wakes on abort as well as on timeout.
 *
 * Extracted from `hn-monitor.ts` when `tick-runner.ts` needed the identical
 * behaviour. A long-running event source that sleeps on a bare `setTimeout`
 * cannot be shut down promptly: SIGINT is observed only after the current
 * sleep elapses, which for a schedule polled once a minute means a minute of
 * apparent hang on every Ctrl-C. Both runners therefore share one
 * implementation rather than each carrying a subtly different copy.
 */

/** Resolve after `ms`, or immediately when `signal` aborts — whichever is first. */
export function sleepInterruptible(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve(); return; }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const onAbort = (): void => {
      if (timer !== undefined) clearTimeout(timer);
      resolve();
    };
    timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}
