import type { CheckFailureKind } from './failure-kinds.js';
import type {
  CompletionReason as ProtocolCompletionReason,
  RunCompletionReason as ProtocolRunCompletionReason,
} from './protocol.js';

export type AuthoredFlowExecutionErrorCode =
  | 'agent_cli_unresolved'
  | 'agent_parked'
  | 'duplicate_completion'
  | 'journal_protocol_violation'
  | 'missing_completion'
  | 'operation_after_completion'
  | 'operation_callback_failed'
  | 'step_failed'
  | 'unsupported_completion'
  | 'unsupported_gate'
  | 'unsupported_header'
  | 'unsettled_derived_work'
  | 'unsupported_promise_lifecycle'
  | 'unsupported_workspace_permission'
  | 'unawaited_step'
  | 'unsupported_verb';

export class AuthoredFlowExecutionError extends Error {
  constructor(
    readonly code: AuthoredFlowExecutionErrorCode,
    message: string,
    readonly completionReason?: ProtocolCompletionReason | ProtocolRunCompletionReason,
    readonly runId?: string,
    /**
     * Set only for `code === 'agent_cli_unresolved'`: the specific preflight
     * refusal kind (`cli_missing`, `model_unknown`, `model_unavailable`, ...)
     * `checkAuthoredFlow` actually produced, so a caller can distinguish a bad
     * model declaration from a missing CLI the same way the declarative
     * `flows check` path's `report.diagnostics[].kind` already lets it —
     * collapsing every refusal to one generic code would lose that taxonomy.
     */
    readonly refusalKind?: CheckFailureKind,
  ) {
    super(`${code}: ${message}`);
    this.name = 'AuthoredFlowExecutionError';
  }
}
