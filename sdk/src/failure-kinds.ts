/** Closed refusal taxonomy for `flows check` (RFC covenant 2). */
export const PREFLIGHT_FAILURE_KINDS = [
  'cli_missing',
  'cli_unauthenticated',
  'cli_unresolved',
  'no_executor',
  'probe_failed',
] as const;

/** Input/command refusals emitted before the pure preflight predicates run. */
export const CHECK_INPUT_FAILURE_KINDS = [
  'config_invalid',
  'input_unreadable',
  'invalid_invocation',
  'invalid_spec',
] as const;

export const CHECK_FAILURE_KINDS = [
  ...CHECK_INPUT_FAILURE_KINDS,
  ...PREFLIGHT_FAILURE_KINDS,
] as const;

export const PREFLIGHT_WARNING_KINDS = [
  'unprovable_effects',
] as const;

export type PreflightFailureKind = (typeof PREFLIGHT_FAILURE_KINDS)[number];
export type CheckFailureKind = (typeof CHECK_FAILURE_KINDS)[number];
export type PreflightWarningKind = (typeof PREFLIGHT_WARNING_KINDS)[number];

const CHECK_FAILURE_KIND_SET: ReadonlySet<string> = new Set(CHECK_FAILURE_KINDS);

export function isCheckFailureKind(value: string): value is CheckFailureKind {
  return CHECK_FAILURE_KIND_SET.has(value);
}
