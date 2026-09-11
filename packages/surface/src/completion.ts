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

/** Authored outcomes include a human handoff; it is not a kernel terminal reason. */
export type FlowCompletionReason = RunCompletionReason | 'needs_human';
