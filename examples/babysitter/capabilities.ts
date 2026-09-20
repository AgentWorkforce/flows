/** Facts about the current surface, not input switches an event can turn on. */
export const capabilities = Object.freeze({
  atomicPrPublication: false,
  durableCrossRunNotification: false,
  journaledCiObservation: false,
  enforcedAgentWriteScope: false,
  selectiveAgentExitRetry: false,
  // The sweep in liveness.ts is pure and proven; what is missing is the durable
  // cross-run wake record it reads. Until a run can journal "subscription X
  // fired at T" where the next run can see it, a subscription that stops firing
  // is invisible — RFC-0001 gate 2's trigger-liveness requirement, unmet.
  durableSubscriptionLiveness: false,
});
export function writeDependency(): string {
  return 'Babysitter needs provider-backed per-PR serialization and an idempotent, head-guarded owned-comment upsert; REST scan/POST/PATCH and per-step receipts do not supply this across runs.';
}
