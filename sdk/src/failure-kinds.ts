const SHARED_SPEC_FAILURE_KINDS = ['invalid_spec'] as const;

/** Environment refusal kinds produced after spec validation succeeds. */
const PREFLIGHT_ENVIRONMENT_FAILURE_KINDS = [
  'cli_missing',
  'cli_unauthenticated',
  'cli_unresolved',
  'cli_unsupported',
  'command_missing',
  'model_unavailable',
  'model_unknown',
  'no_executor',
  'probe_failed',
] as const;

/** Closed refusal taxonomy for public preflight (RFC covenant 2). */
export const PREFLIGHT_FAILURE_KINDS = [
  ...SHARED_SPEC_FAILURE_KINDS,
  ...PREFLIGHT_ENVIRONMENT_FAILURE_KINDS,
] as const;

/** Input/command refusals emitted before the pure preflight predicates run. */
export const CHECK_INPUT_FAILURE_KINDS = [
  'config_invalid',
  'input_invalid',
  'input_missing',
  'input_unreadable',
  'invalid_invocation',
  ...SHARED_SPEC_FAILURE_KINDS,
] as const;

export const CHECK_FAILURE_KINDS = [
  ...CHECK_INPUT_FAILURE_KINDS,
  ...PREFLIGHT_ENVIRONMENT_FAILURE_KINDS,
] as const;

/**
 * Warnings never refuse. Covenant 2 asks preflight to refuse *or warn* on
 * anything it cannot prove, so a deterministic step always leaves exactly one
 * of these: its command resolved (effects still unknowable), it did not
 * resolve, or it could not be probed at all. Silence is not one of the states.
 *
 * `vacuous_gate` is the same principle applied to a declared gate that judges
 * nothing: `schema: {}` and `schema: true` are legal and accepted, but a gate
 * accepting every output must not be reported as if it constrained one.
 */
export const PREFLIGHT_WARNING_KINDS = [
  'unprovable_effects',
  'command_unresolved',
  'command_unprovable',
  'vacuous_gate',
] as const;

/** Closed outcome taxonomy owned by the `flows run` / `flows resume` surface. */
export const RUN_FAILURE_KINDS = [
  'daemon_unreachable',
  'protocol_error',
  'run_parked',
  'run_unavailable',
] as const;

export type PreflightFailureKind = (typeof PREFLIGHT_FAILURE_KINDS)[number];
export type CheckFailureKind = (typeof CHECK_FAILURE_KINDS)[number];
export type PreflightWarningKind = (typeof PREFLIGHT_WARNING_KINDS)[number];
export type RunFailureKind = (typeof RUN_FAILURE_KINDS)[number];

const CHECK_FAILURE_KIND_SET: ReadonlySet<string> = new Set(CHECK_FAILURE_KINDS);
const RUN_FAILURE_KIND_SET: ReadonlySet<string> = new Set(RUN_FAILURE_KINDS);

export function isCheckFailureKind(value: string): value is CheckFailureKind {
  return CHECK_FAILURE_KIND_SET.has(value);
}

export function isRunFailureKind(value: string): value is RunFailureKind {
  return RUN_FAILURE_KIND_SET.has(value);
}
