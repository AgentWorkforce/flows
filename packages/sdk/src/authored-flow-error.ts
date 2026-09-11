import type {
  CompletionReason as ProtocolCompletionReason,
  RunCompletionReason as ProtocolRunCompletionReason,
} from './protocol.js';

export type AuthoredFlowExecutionErrorCode =
  | 'helper_slack.credential_missing'
  | 'helper_slack.mount_required'
  | 'budget_syntax_invalid'
  | 'budget_missing_price'
  | 'agent_cli_unresolved'
  | 'agent_parked'
  | 'llm_cli_unresolved'
  | 'llm_parked'
  | 'duplicate_completion'
  | 'journal_protocol_violation'
  | 'missing_completion'
  | 'memory_unreachable'
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
  ) {
    super(`${code}: ${message}`);
    this.name = 'AuthoredFlowExecutionError';
  }
}
