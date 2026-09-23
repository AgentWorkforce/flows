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

/**
 * The bound on the optional `done()` detail, in Unicode code points of the
 * FINAL normalized string — truncation suffix included.
 *
 * Stated in code points rather than `String.length` on purpose: `.length`
 * counts UTF-16 code units, so an emoji-heavy detail measured that way is
 * half the length a reader would call it. The number is the same order the
 * kernel uses for a gate's free-text detail
 * (`kernel/relayflowd/src/engine/remote.rs`), but it is not the same bound:
 * that one takes 2,000 characters and then appends its suffix.
 *
 * The runtime enforces this; it is exported so an author can measure a detail
 * before passing one.
 */
export const COMPLETION_DETAIL_MAX_CODE_POINTS = 2000;
