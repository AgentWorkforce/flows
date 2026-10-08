import { JournalFrameError, JournalProtocolError, type JournalClient } from '../journal-client.js';
import { AuthoredFlowExecutionError } from '../authored-flow-error.js';
import type { JournalEvent } from '../journal-reader.js';
import type { RunLifecycleOptions, ParkedStep } from './run.js';

export const LEASE_SWEEP_GRACE_MS = 5_000;
const LEASE_POLL_MS = 2_000;
const STALE_LEASE_MS = 30_000 + LEASE_SWEEP_GRACE_MS;
export interface RunningStep extends ParkedStep { leaseDeadlineMs: number }

/** Watch completion; snapshots only refresh the non-journaled live lease deadline. */
export async function waitForRunningStep(client: JournalClient, runId: string,
  runningStep: RunningStep, options: RunLifecycleOptions): Promise<void> {
  let leaseDeadlineMs = runningStep.leaseDeadlineMs;
  if (!Number.isFinite(leaseDeadlineMs)) {
    throw new Error(`running step "${runningStep.id}" omitted lease_deadline_ms`);
  }
  const notify = () => options.onWait?.({ runId, stepId: runningStep.id,
    stepType: runningStep.type, leaseDeadlineMs });
  notify();
  let deadlineSeenAt = performance.now();
  // The protocol has no unwatch. Closing this scoped, non-worker session removes
  // the server watcher, even on cancellation or a read/registration failure.
  const watch = client.createPeer();
  let settled = false;
  let ready = false;
  let finish: () => void = () => {};
  let cancel: () => void = () => {};
  let fail: (error: unknown) => void = () => {};
  const canceled = () => new Error(`worker wait for step "${runningStep.id}" was canceled`);
  const completed = new Promise<void>((resolve, reject) => {
    finish = resolve;
    cancel = () => reject(canceled());
    fail = reject;
  });
  // The subscription handshake itself may be pending when cancellation arrives.
  void completed.catch(() => {});
  // A completion push aborts the lease snapshot in flight: the answer is known.
  let snapshotRead: AbortController | undefined;
  const onEntry = (entry: JournalEvent) => {
    if (entry.run_id !== runId) return;
    if (entry.entry_type === 'run.completed') settled = true;
    else if (entry.step_id === runningStep.id) {
      if (entry.entry_type === 'step.attempt.started') settled = false;
      if (entry.entry_type === 'step.completed' || entry.entry_type === 'wait.human') settled = true;
    }
    // Fold the entire replay before deciding: an older attempt may have failed.
    if (ready && settled) {
      finish();
      snapshotRead?.abort(new Error(`step "${runningStep.id}" completed during the lease snapshot`));
    }
  };
  watch.on('entry', onEntry);
  // A malformed frame after registration has no pending request to reject: fail closed here.
  let protocolFailure: unknown;
  const onProtocolError = (error: unknown) => { protocolFailure ??= error; fail(error); snapshotRead?.abort(error); };
  watch.on('protocol_error', onProtocolError);
  // A dropped watch loses its completion pushes: a resumable read interruption.
  const onDisconnected = (error: Error) => {
    if (settled) return;
    const lost = new AuthoredFlowExecutionError('daemon_unresponsive',
      `the completion watch for step "${runningStep.id}" disconnected: ${error.message}`);
    protocolFailure ??= lost;
    fail(lost);
    snapshotRead?.abort(lost);
  };
  watch.on('disconnected', onDisconnected);
  options.signal?.addEventListener('abort', cancel, { once: true });
  if (options.signal?.aborted) cancel();
  try {
    // Every transport failure up to and including the watch registration is a
    // read interruption: the step may still be running and the run resumable.
    await Promise.race([watch.connect().then(() => watch.hello('flows-step-watch'))
      .then(() => watch.runWatch(runId)).catch(error => {
        // Refusals and malformed frames are protocol facts, not lost transport: fail closed.
        if (error instanceof JournalProtocolError || error instanceof JournalFrameError) throw error;
        throw new AuthoredFlowExecutionError('daemon_unresponsive',
          `could not establish the completion watch: ${error instanceof Error ? error.message : String(error)}`);
      }), completed]);
    ready = true;
    if (settled) return;
    while (true) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      let releaseTimer: () => void = () => {};
      try {
        const elapsed = await Promise.race([
          new Promise<boolean>(resolve => { releaseTimer = () => resolve(false); timer = setTimeout(() => resolve(true), LEASE_POLL_MS); }),
          completed.then(() => false),
        ]);
        if (!elapsed) return;
      } finally { clearTimeout(timer); releaseTimer(); }
      // Drain the read before leaving the authored promise scope. A raced but
      // unresolved read would look like unawaited derived work to that scope,
      // so cancellation aborts the read itself and it settles at once.
      const read = snapshotRead = new AbortController();
      const signal = options.signal === undefined ? read.signal
        : AbortSignal.any([options.signal, read.signal]);
      const snapshot = await client.runGet(runId, { signal })
        .catch(error => {
          if (options.signal?.aborted) throw canceled();
          if (protocolFailure !== undefined) throw protocolFailure;
          // A completion push aborted this read: completion was observed, and
          // finish() is one-shot, even if a retry attempt started right after.
          if (settled || read.signal.aborted) return undefined;
          throw error;
        })
        .finally(() => { snapshotRead = undefined; });
      if (options.signal?.aborted) throw canceled();
      if (protocolFailure !== undefined) throw protocolFailure;
      if (settled || snapshot === undefined || snapshot.steps[runningStep.id]?.state !== 'running') return;
      const deadline = snapshot.steps[runningStep.id]?.lease_deadline_ms;
      if (deadline !== undefined && deadline !== leaseDeadlineMs) {
        leaseDeadlineMs = deadline;
        deadlineSeenAt = performance.now();
        notify();
      } else if (performance.now() - deadlineSeenAt > STALE_LEASE_MS) {
        // A stalled sweep/renewal is not evidence that the body itself failed.
        throw new AuthoredFlowExecutionError('daemon_unresponsive',
          `worker lease for step "${runningStep.id}" expired at ${leaseDeadlineMs} without completion; relayflowd's lease sweep may be delayed by CPU load`);
      }
    }
  } finally {
    finish();
    options.signal?.removeEventListener('abort', cancel);
    watch.off('entry', onEntry);
    watch.off('protocol_error', onProtocolError);
    watch.off('disconnected', onDisconnected);
    watch.close();
  }
}
