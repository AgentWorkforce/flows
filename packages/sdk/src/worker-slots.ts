/** The local agent worker's default concurrency, and the ceiling `--agent-capacity` accepts. */
export const DEFAULT_LOCAL_AGENT_CAPACITY = 4;
export const MAX_LOCAL_AGENT_CAPACITY = 32;

/** A positive integer no larger than the ceiling; anything else is not a capacity. */
export function isAgentCapacity(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= MAX_LOCAL_AGENT_CAPACITY;
}

/**
 * First-come admission to a worker that holds `capacity` dispatches at once.
 *
 * The kernel never queues a step for a busy worker: an attempt with no worker
 * below capacity parks the run ("no worker is attached for step type …"). An
 * authored body opens one child run per `f.agent`/`f.llm`, so `Promise.all`
 * over more calls than the worker holds would park the overflow. Holding the
 * overflow here, before `run.start`, keeps the kernel's admission exact and
 * turns "too many at once" into "wait for a slot".
 */
export class WorkerSlots {
  private held = 0;
  private readonly waiting: Array<{ resolve: () => void; reject: (reason: unknown) => void }> = [];
  private closed: { readonly reason: unknown } | undefined;

  constructor(readonly capacity: number) {
    if (!isAgentCapacity(capacity)) throw new RangeError(`worker capacity must be an integer from 1 to ${MAX_LOCAL_AGENT_CAPACITY} (got ${capacity})`);
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.closed !== undefined) throw this.closed.reason;
    if (this.held < this.capacity) this.held++;
    // A released slot is handed straight to the next waiter, so `held` never
    // dips below capacity while anyone is queued and no later caller can jump it.
    else {
      await new Promise<void>((resolve, reject) => this.waiting.push({ resolve, reject }));
      // Woken with the slot, but the body may have failed in between (see release).
      const closed = this.closedReason();
      if (closed !== undefined) {
        this.release();
        throw closed.reason;
      }
    }
    try {
      return await work();
    } finally {
      this.release();
    }
  }

  /** Read through a call so a check after an `await` is not narrowed away. */
  private closedReason(): { readonly reason: unknown } | undefined {
    return this.closed;
  }

  /**
   * Hand the slot to the next waiter on a later macrotask, not synchronously.
   * When the work that held it rejected and that rejection fails the body, the
   * failure reaches `close` through microtasks only (operation → Promise.all →
   * body → executor). Waking the waiter synchronously let it admit a child run
   * before `close` could refuse it; deferring lets the teardown land first.
   */
  private release(): void {
    const next = this.waiting.shift();
    if (next === undefined) {
      this.held--;
      return;
    }
    setImmediate(() => {
      if (this.closed === undefined) {
        next.resolve();
        return;
      }
      // Closed meanwhile. `close` could not see this waiter (already taken off
      // the queue), so refuse it here, and pass the slot on instead of leaking it.
      next.reject(this.closed.reason);
      this.release();
    });
  }

  /**
   * Refuse every queued and future admission with `reason`; work already
   * holding a slot is not interrupted. The authored body calls this when it
   * fails: a queued call is already `running` as an operation, so operation
   * cancellation cannot reach it, and without this it would still be admitted
   * and run after the flow had failed.
   */
  close(reason: unknown): void {
    if (this.closed !== undefined) return;
    this.closed = { reason };
    for (const waiter of this.waiting.splice(0)) waiter.reject(reason);
  }
}
