import { PLUGIN_FAILURE_KINDS } from './plugin-manifest.js';
import { NAMED_GATE_FAILURE_KINDS } from './named-gates.js';
const SHARED_SPEC_FAILURE_KINDS = ['invalid_spec'] as const;

/** Environment refusal kinds produced after spec validation succeeds. */
const PREFLIGHT_ENVIRONMENT_FAILURE_KINDS = [
  ...NAMED_GATE_FAILURE_KINDS,
  ...PLUGIN_FAILURE_KINDS,
  'helper_provider.mount_required',
  'helper_provider.unsupported',
  'helper_slack.credential_missing',
  'helper_slack.mount_required',
  'helper_mount_required',
  'mcp_undeclared_server',
  'mcp_unreachable',
  'budget_syntax_invalid',
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
  'scope_syntax_invalid',
  'mount_unknown',
  'scope_ungrantable',
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
 *
 * `budget_unmetered` names an LLM/agent step under a dollar budget whose model
 * has no frozen price (including Codex, which selects its own model). A
 * missing price never refuses: the step runs, journals its tokens with
 * `dollars_unmetered: true`, and cannot cross `maxDollars`; token limits still
 * apply. It replaced the `budget_missing_price` refusal (#421), which older
 * `flows check` reports may still show.
 *
 * `permissions_unenforced` names an agent step that declares `permissions`.
 * Gate 1 validates the declaration and the compiled step spec records it, but
 * nothing reads it to gate a file or network access — enforcement is gate 8
 * (#442). Warning-only by design: the declaration stays legal and the flow
 * still runs, but an author who wrote one must not be left believing it
 * sandboxes the step.
 */
export const PREFLIGHT_WARNING_KINDS = [
  'unprovable_effects',
  'managed_cli_unverified',
  'command_unresolved',
  'command_unprovable',
  'vacuous_gate',
  'budget_unmetered',
  'permissions_unenforced',
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
 *
 * Despite the name, this list is the run-outcome diagnostic vocabulary rather
 * than failures alone. `run_parked` has always sat here and exits 3 under
 * severity `parked`; `run_declined` joins it, exiting 0 under severity
 * `declined`. The mismatch between the constant's name and its non-failure
 * members is pre-existing — renaming it is a separate change, and neither this
 * list nor `RunDiagnostic` is exported from the package index.
 */
export const RUN_FAILURE_KINDS = [
  'bucket_unconfigured',
  'bucket_unreachable',
  'bundle_signature_invalid',
  'bundle_unsupported',
  'human_influenced_run',
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
  'run_declined',
  'run_unavailable',
  /** A predicate `.gate(fn)` judged false; the verdict is journaled as `<step>.gate`. */
  'gate_failed',
  /** `flows answer` named a wait the run is not asking: unknown, or already answered. */
  'human_wait_unknown',
  /**
   * `--local-agent` cannot be honoured for this invocation, so it is refused
   * rather than accepted and ignored. A local agent worker is admitted at run
   * start and pinned into the authored root's metadata; a resume can only
   * reproduce the surface the root was started with. Exit 2, before any worker
   * attaches and before the resume touches the journal.
   */
  'local_agent_unavailable',
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

/**
 * Why a run parked, for the reporting side that has to name a remedy.
 *
 * `worker_unavailable` is a step nothing is attached to run — the one case
 * `--local-agent` fixes. `needs_human` is the kernel's manual-recovery wait
 * after a worker attempt already failed, and attaching a worker does not clear
 * it. Both arrive as exit 3 under `run_parked`, so the distinction has to
 * travel as a value: it lives here, beside the run vocabulary, because the
 * classifier (cli/run.ts), the authored error boundary (authored-flow-error.ts)
 * and the remedy formatter (cli/local-agent-remedy.ts) all need the same one
 * and none of them may depend on the others.
 */
export type ParkCause = 'worker_unavailable' | 'needs_human';

/**
 * Optional evidence on the existing step_failed diagnostic, not a new kind.
 *
 * Every field is optional because a failure must be reportable on whatever it
 * left behind. A deterministic step leaves `exitCode` plus output tails; an
 * agent or llm step leaves `completionReason` and whatever the daemon captured
 * into `detail` (see cli/step-failure.ts). Absent means "not journaled", never
 * "zero" — an exit code is only ever reported when one was actually recorded.
 */
export interface StepFailedDetails {
  stepId?: string;
  /** `deterministic` | `llm` | `agent`, when the run snapshot named one. */
  stepType?: string;
  /** The kernel's per-step reason, e.g. `worker_error`, `retries_exhausted`. */
  completionReason?: string;
  /**
   * The attempt this failure was recorded on, from the journal entry envelope.
   * Absent when the journal did not name one — never defaulted to 1, because
   * "how many attempts ran is unknown" and "exactly one ran" are different
   * answers and only the second is evidence.
   */
  attempt?: number;
  /**
   * The step's attempt budget, from `step.attempt.started`'s `max_iterations`.
   * Reported beside `retries_exhausted` so that reason cannot be read as
   * "retries happened": a deterministic step's default budget is 1, so a
   * single failed attempt with no retry at all terminates as
   * `retries_exhausted`.
   */
  maxIterations?: number;
  exitCode?: number;
  /** Terminal-safe UTF-8 excerpt, at most 1,024 bytes. */
  stdoutTail?: string;
  /** Terminal-safe UTF-8 excerpt, at most 1,024 bytes. */
  stderrTail?: string;
  /**
   * The daemon's own account when it was not a render of the fields above, or
   * — preferred when present — the failure excerpt from the worker's
   * transcript digest (`trajectory_tail.transcript.failure`).
   */
  detail?: string;
  /** The attempt's redacted `stream-json` transcript on disk, when the worker wrote one. */
  transcriptPath?: string;
  /** A runnable `flows replay` invocation for this run. */
  hint?: string;
  /** The on-disk journal for this run, when the data dir is known. */
  journalPath?: string;
}

const CHECK_FAILURE_KIND_SET: ReadonlySet<string> = new Set(CHECK_FAILURE_KINDS);
const RUN_FAILURE_KIND_SET: ReadonlySet<string> = new Set(RUN_FAILURE_KINDS);

export function isCheckFailureKind(value: string): value is CheckFailureKind {
  return CHECK_FAILURE_KIND_SET.has(value);
}

export function isRunFailureKind(value: string): value is RunFailureKind {
  return RUN_FAILURE_KIND_SET.has(value);
}
