/** Facts about the current surface, not input switches an event can turn on. */
export const capabilities = Object.freeze({
  atomicPrPublication: false,
  durableCrossRunNotification: false,
  journaledCiObservation: false,
  enforcedAgentWriteScope: false,
  selectiveAgentExitRetry: false,
});
export function writeDependency(): string {
  return 'Babysitter needs provider-backed per-PR serialization and an idempotent, head-guarded owned-comment upsert; REST scan/POST/PATCH and per-step receipts do not supply this across runs.';
}
