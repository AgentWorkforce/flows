import type { JournalClient } from './journal-client.js';
import type { StepDispatchEvent } from './protocol.js';

// Comfortably inside the kernel's 30-second lease. Schedule from dispatch,
// then from each acknowledgement so slow requests never overlap.
const HEARTBEAT_INTERVAL_MS = 10_000;

export function startWorkerHeartbeat(client: JournalClient, dispatch: StepDispatchEvent) {
  const errors: unknown[] = [];
  let stopped = false;
  let pending = Promise.resolve();
  let timer: ReturnType<typeof setTimeout>;
  const schedule = (): void => {
    timer = setTimeout(() => {
      pending = renew();
    }, HEARTBEAT_INTERVAL_MS);
  };
  const renew = async (): Promise<void> => {
    try {
      await client.stepHeartbeat(
        dispatch.run_id, dispatch.step_id, dispatch.attempt, dispatch.lease_id,
      );
      if (!stopped) schedule();
    } catch (error) {
      // The owner reports these through its error event after preserving the
      // CLI result in a worker_error completion. Never retry a lost lease.
      errors.push(error);
      stopped = true;
    }
  };
  schedule();
  return {
    errors,
    stop(): Promise<void> {
      stopped = true;
      clearTimeout(timer);
      // A dispatched request cannot be unsent. Drain it before step.complete
      // so a late heartbeat cannot renew an already completed attempt.
      return pending;
    },
  };
}
