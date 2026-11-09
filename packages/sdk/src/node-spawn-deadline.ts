import type { NodeSpawnReceipt } from './node-spawn.js';

/** Races a side-effect-free node read/runtime acquisition against its caller deadline. */
export async function waitForNodeOperation<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  // Fold a late rejection from a transport that ignored cancellation.
  const outcome = pending.then(value => ({ ok: true as const, value }), error => ({ ok: false as const, error }));
  try {
    const settled = await Promise.race([outcome, aborted]);
    if (!settled.ok) throw settled.error;
    return settled.value;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}

/** Preserves the exact receipt when spawn confirmation settles after cancellation. */
export async function waitForNodeSpawn(
  pending: Promise<NodeSpawnReceipt>,
  signal: AbortSignal,
  onLate: (outcome: { spawn?: NodeSpawnReceipt; error?: unknown }) => void,
): Promise<NodeSpawnReceipt> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException('The operation was aborted', 'AbortError'));
    signal.addEventListener('abort', onAbort, { once: true });
  });
  try { return await Promise.race([pending, aborted]); }
  catch (error) {
    if (signal.aborted) {
      void pending.then(spawn => onLate({ spawn }), lateError => onLate({ error: lateError }));
    }
    throw error;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener('abort', onAbort);
  }
}
