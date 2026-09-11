const SHARED_SPEC_FAILURE_KINDS = ['invalid_spec'] as const;

/** Environment refusal kinds produced after spec validation succeeds. */
const PREFLIGHT_ENVIRONMENT_FAILURE_KINDS = [
  'helper_slack.credential_missing',
  'helper_slack.mount_required',
  'mcp_undeclared_server',
  'mcp_unreachable',
  'budget_syntax_invalid',
  'budget_missing_price',
  'cli_missing',
  'cli_unauthenticated',
  'cli_unresolved',
  'cli_unsupported',
  'command_missing',
  'model_unavailable',
  'model_unknown',
  'memory_unreachable',
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
  'input_too_large',
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

/**
 * Closed outcome taxonomy owned by the `flows run` / `flows resume` surface.
 *
 * The four daemon-lifecycle kinds after `daemon_unreachable` are the
 * attach-or-spawn refusals from kernel/DAEMON-LIFECYCLE.md §3. They split what
 * used to be one message: `daemon_unreachable` now means only "nothing is
 * serving and this invocation was told not to start one" (`--no-spawn`), while
 * a spawn that was attempted and did not produce a serving daemon names which
 * step failed. All of them are still exit 2 — refused before a journal write.
 */
export const RUN_FAILURE_KINDS = [
  'reuse_spec_mismatch',
  'reuse_run_not_found',
  'reuse_journal_read_failed',
  'daemon_unreachable',
  'daemon_protocol_mismatch',
  'daemon_start_failed',
  'daemon_start_timeout',
  'relayflowd_not_found',
  'protocol_error',
  'run_parked',
  'run_unavailable',
] as const;

/**
 * Non-refusing outcomes of the attach step. `connection_file_stale` is
 * DAEMON-LIFECYCLE.md §2 row 2: the socket answered while `connection.json`
 * described a process that is gone. The socket is the authority, so this
 * attaches — but it says so rather than passing in silence.
 */
export const RUN_WARNING_KINDS = [
  'connection_file_stale',
] as const;

/** File-level editor hints emitted by flows check, outside pure preflight. */
export const CHECK_WARNING_KINDS = ['editor_schema_missing'] as const;
export type CheckWarningKind = (typeof CHECK_WARNING_KINDS)[number];

export type PreflightFailureKind = (typeof PREFLIGHT_FAILURE_KINDS)[number];
export type CheckFailureKind = (typeof CHECK_FAILURE_KINDS)[number];
export type PreflightWarningKind = (typeof PREFLIGHT_WARNING_KINDS)[number];
export type RunFailureKind = (typeof RUN_FAILURE_KINDS)[number];
export type RunWarningKind = (typeof RUN_WARNING_KINDS)[number];

const CHECK_FAILURE_KIND_SET: ReadonlySet<string> = new Set(CHECK_FAILURE_KINDS);
const RUN_FAILURE_KIND_SET: ReadonlySet<string> = new Set(RUN_FAILURE_KINDS);

export function isCheckFailureKind(value: string): value is CheckFailureKind {
  return CHECK_FAILURE_KIND_SET.has(value);
}

export function isRunFailureKind(value: string): value is RunFailureKind {
  return RUN_FAILURE_KIND_SET.has(value);
}
