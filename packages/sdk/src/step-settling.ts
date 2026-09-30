/**
 * A step's LAST settling `step.completed`: the verdict the kernel settled the
 * step on. `retry` and `park` completions record an attempt the kernel did
 * NOT settle it on (relayflowd-core `Disposition`) — crash recovery's
 * `crashed`, a `worker_error` with iterations left — and precede the attempt
 * that did, so neither the first completion nor a completion count is the
 * step's verdict. Shared by the authored reader and the Bun result verifier,
 * which must agree on which completion a claim is judged against.
 */
export function settlingCompletion<T>(entries: readonly T[], stepId: string): T | undefined {
  return entries.filter(entry => {
    if (typeof entry !== 'object' || entry === null) return false;
    const { entry_type: type, step_id: step, payload } = entry as Record<string, unknown>;
    if (type !== 'step.completed' || step !== stepId) return false;
    const disposition = typeof payload === 'object' && payload !== null
      ? (payload as Record<string, unknown>)['disposition'] : undefined;
    return disposition !== 'retry' && disposition !== 'park';
  }).at(-1);
}
