/** The closed step completion vocabulary from the journal protocol. */
export const COMPLETION_REASONS = [
  "success",
  "verification_failed",
  "retries_exhausted",
  "lease_expired",
  "crashed",
  "timeout",
  "worker_error",
  "budget_exceeded",
  "canceled",
] as const;

export type CompletionReason = (typeof COMPLETION_REASONS)[number];

/** The closed run completion vocabulary from the journal protocol. */
export const RUN_COMPLETION_REASONS = [
  "success",
  "step_failed",
  "canceled",
  "budget_exceeded",
] as const;

export type RunCompletionReason = (typeof RUN_COMPLETION_REASONS)[number];

/** Authored verdicts include handoff and declination without widening kernel facts. */
export const FLOW_COMPLETION_REASONS = [
  ...RUN_COMPLETION_REASONS,
  'needs_human',
  'declined',
] as const;

export type FlowCompletionReason = (typeof FLOW_COMPLETION_REASONS)[number];
