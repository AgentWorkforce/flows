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
  private readonly waiting: Array<() => void> = [];

  constructor(readonly capacity: number) {
    if (!isAgentCapacity(capacity)) throw new RangeError(`worker capacity must be an integer from 1 to ${MAX_LOCAL_AGENT_CAPACITY} (got ${capacity})`);
  }

  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.held < this.capacity) this.held++;
    // A released slot is handed straight to the next waiter, so `held` never
    // dips below capacity while anyone is queued and no later caller can jump it.
    else await new Promise<void>(resolve => this.waiting.push(resolve));
    try {
      return await work();
    } finally {
      const next = this.waiting.shift();
      if (next !== undefined) next(); else this.held--;
    }
  }
}
