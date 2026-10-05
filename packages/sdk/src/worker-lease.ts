import { JournalProtocolError, JournalRequestTimeoutError, type JournalClient } from './journal-client.js';
import type { StepDispatchEvent } from './protocol.js';

export class WorkerLeaseLostError extends Error {
  constructor(
    readonly reason: 'already_expired' | 'renewal_expired' | 'completion_expired',
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'WorkerLeaseLostError';
  }
}

/** No cause traversal: worker errors preserve their original identity. */
export function isLeaseLost(error: unknown): boolean {
  return error instanceof WorkerLeaseLostError || (error instanceof JournalProtocolError
    && (error.code === 'lease_conflict' || (error.code === 'run_terminal'
      && ['step.heartbeat', 'step.complete', 'step.wait'].includes(error.verb ?? ''))));
}

export function onWorkerFailure(label: string, fatal: (error: unknown) => void) {
  return (error: unknown, dispatch?: StepDispatchEvent): void => {
    // Without the dispatch there is no attempt to hand back to the kernel: fail closed.
    if (!isLeaseLost(error) || dispatch === undefined) { fatal(error); return; }
    // The kernel owns this attempt's fate; its journal supplies the run outcome.
    // stderr keeps this diagnostic out of structured reports on stdout.
    process.emitWarning(
      `${label}: run_id=${dispatch.run_id} step_id=${dispatch.step_id} attempt=${dispatch.attempt}: ${String(error)}`,
      { code: 'FLOWS_WORKER_LEASE_LOST' },
    );
  };
}

/** Hold the dispatched lease only while its subprocess is still ours to run. */
export async function withWorkerLease<T>(
  client: JournalClient,
  dispatch: StepDispatchEvent,
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let stopped = false;
  // Every deadline below is on THIS process's monotonic clock. The daemon
  // issues `lease_deadline_ms` on its own wall clock, and comparing it with
  // ours made the lease exactly as good as the two clocks' agreement: a
  // worker 45s ahead refused every dispatch as already expired, one 75s
  // behind scheduled its first renewal after the daemon had swept the lease
  // (customer rw_3a0fcb71; tests/worker-lease-drift-live.test.ts).
  let latestDeadline = Number.NaN;
  let renewalTimer: NodeJS.Timeout | undefined;
  let expiryTimer: NodeJS.Timeout | undefined;
  let pending: Promise<void> = Promise.resolve();
  const fail = (error: unknown): void => { controller.abort(error); };
  const armExpiry = (deadline: number): number => {
    const remaining = deadline - performance.now();
    if (!Number.isFinite(remaining)) {
      throw new Error(`Agent lease is already expired for ${dispatch.run_id}/${dispatch.step_id}.`);
    }
    if (remaining <= 0) {
      throw new WorkerLeaseLostError('already_expired', `Agent lease is already expired for ${dispatch.run_id}/${dispatch.step_id}.`);
    }
    latestDeadline = deadline;
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => fail(new WorkerLeaseLostError('renewal_expired',
      `Agent lease expired before renewal for ${dispatch.run_id}/${dispatch.step_id}.`,
    )), remaining);
    return remaining;
  };
  const renew = async (): Promise<void> => {
    // Anchored BEFORE the request: the daemon starts the renewed lease no
    // earlier than it receives this, so the local deadline errs early.
    const sentAt = performance.now();
    const result = await untilAborted(client.stepHeartbeat(
      dispatch.run_id, dispatch.step_id, dispatch.attempt, dispatch.lease_id,
    ), controller.signal).catch(error => {
      if (error instanceof JournalRequestTimeoutError && error.verb === 'step.heartbeat') {
        throw new WorkerLeaseLostError('renewal_expired', error.message, { cause: error });
      }
      throw error;
    });
    controller.signal.throwIfAborted();
    // A response handled after local expiry cannot revive ownership, even
    // if its future deadline was issued before this event loop stalled.
    if (performance.now() >= latestDeadline) {
      throw new WorkerLeaseLostError('renewal_expired', `Agent lease expired before renewal for ${dispatch.run_id}/${dispatch.step_id}.`);
    }
    const remaining = armExpiry(localDeadline(result.lease_deadline_ms, result.lease_ttl_ms, sentAt));
    if (!stopped) {
      renewalTimer = setTimeout(() => {
        pending = renew().catch(fail);
      }, Math.max(1, Math.floor(remaining / 3)));
    }
  };
  try {
    armExpiry(localDeadline(dispatch.lease_deadline_ms, dispatch.lease_ttl_ms, performance.now()));
    // Establish ownership before starting an effectful process.
    await renew();
    let result: T;
    try {
      result = await execute(controller.signal);
    } catch (error) {
      // A body that rejected because the lease was lost under it reports
      // whatever its wait happened to say ("worker wait canceled"). The lease
      // is the cause, and callers branch on it (isLeaseLost): an attempt the
      // kernel will retry must not be recorded as the body's own failure.
      const lost = controller.signal.reason;
      if (isLeaseLost(lost) && error !== lost) {
        if (lost instanceof WorkerLeaseLostError) {
          throw new WorkerLeaseLostError(lost.reason, lost.message, { cause: error });
        }
        throw lost;
      }
      throw error;
    }
    stopped = true;
    if (renewalTimer !== undefined) clearTimeout(renewalTimer);
    // Drain any renewal before the caller sends step.complete. A renewal
    // racing after completion would otherwise report a spurious lease error.
    await pending;
    controller.signal.throwIfAborted();
    // Timer callbacks can be delayed behind a resolved subprocess promise.
    // Check the clock itself before permitting step.complete.
    if (performance.now() >= latestDeadline) {
      throw new WorkerLeaseLostError('completion_expired', `Agent lease expired before completion for ${dispatch.run_id}/${dispatch.step_id}.`);
    }
    return result;
  } finally {
    stopped = true;
    controller.abort(new Error('Worker lease scope ended.'));
    if (renewalTimer !== undefined) clearTimeout(renewalTimer);
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    await pending;
  }
}

/**
 * A daemon lease deadline on this process's monotonic clock. With the
 * daemon's `lease_ttl_ms` the wall clocks never meet: the duration is added to
 * `anchor`, a moment no later than the daemon started it. An older daemon
 * sends only the absolute deadline, which keeps the old wall-clock comparison
 * -- read NOW, not at `anchor`, or the round trip would be subtracted twice.
 */
function localDeadline(daemonDeadlineMs: number, ttlMs: number | undefined, anchor: number): number {
  if (typeof ttlMs === 'number' && Number.isFinite(ttlMs)) return anchor + ttlMs;
  return performance.now() + (daemonDeadlineMs - Date.now());
}

function untilAborted<T>(request: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = (): void => { reject(signal.reason); };
    signal.addEventListener('abort', abort, { once: true });
    request.then(value => {
      signal.removeEventListener('abort', abort);
      resolve(value);
    }, error => {
      signal.removeEventListener('abort', abort);
      reject(error);
    });
    if (signal.aborted) abort();
  });
}
