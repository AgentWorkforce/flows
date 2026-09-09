import type { JournalClient } from './journal-client.js';
import type { StepDispatchEvent } from './protocol.js';

/** Hold the dispatched lease only while its subprocess is still ours to run. */
export async function withWorkerLease<T>(
  client: JournalClient,
  dispatch: StepDispatchEvent,
  execute: (signal: AbortSignal) => Promise<T>,
): Promise<T> {
  const controller = new AbortController();
  let stopped = false;
  let latestDeadline = dispatch.lease_deadline_ms;
  let renewalTimer: NodeJS.Timeout | undefined;
  let expiryTimer: NodeJS.Timeout | undefined;
  let pending: Promise<void> = Promise.resolve();
  const fail = (error: unknown): void => { controller.abort(error); };
  const armExpiry = (deadline: number): number => {
    const remaining = deadline - Date.now();
    if (!Number.isFinite(remaining) || remaining <= 0) {
      throw new Error(`Agent lease is already expired for ${dispatch.run_id}/${dispatch.step_id}.`);
    }
    latestDeadline = deadline;
    if (expiryTimer !== undefined) clearTimeout(expiryTimer);
    expiryTimer = setTimeout(() => fail(new Error(
      `Agent lease expired before renewal for ${dispatch.run_id}/${dispatch.step_id}.`,
    )), remaining);
    return remaining;
  };
  const renew = async (): Promise<void> => {
    const result = await untilAborted(client.stepHeartbeat(
      dispatch.run_id, dispatch.step_id, dispatch.attempt, dispatch.lease_id,
    ), controller.signal);
    controller.signal.throwIfAborted();
    // A response handled after local expiry cannot revive ownership, even
    // if its future deadline was issued before this event loop stalled.
    if (Date.now() >= latestDeadline) {
      throw new Error(`Agent lease expired before renewal for ${dispatch.run_id}/${dispatch.step_id}.`);
    }
    const remaining = armExpiry(result.lease_deadline_ms);
    if (!stopped) {
      renewalTimer = setTimeout(() => {
        pending = renew().catch(fail);
      }, Math.max(1, Math.floor(remaining / 3)));
    }
  };
  try {
    armExpiry(dispatch.lease_deadline_ms);
    // Establish ownership before starting an effectful process.
    await renew();
    const result = await execute(controller.signal);
    stopped = true;
    if (renewalTimer !== undefined) clearTimeout(renewalTimer);
    // Drain any renewal before the caller sends step.complete. A renewal
    // racing after completion would otherwise report a spurious lease error.
    await pending;
    controller.signal.throwIfAborted();
    // Timer callbacks can be delayed behind a resolved subprocess promise.
    // Check the clock itself before permitting step.complete.
    if (Date.now() >= latestDeadline) {
      throw new Error(`Agent lease expired before completion for ${dispatch.run_id}/${dispatch.step_id}.`);
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
