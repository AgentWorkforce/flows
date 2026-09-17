import type {
  CompletionReason as ProtocolCompletionReason,
  RunCompletionReason as ProtocolRunCompletionReason,
} from './protocol.js';

export type AuthoredFlowExecutionErrorCode =
  | 'helper_provider.mount_required'
  | 'helper_provider.unsupported'
  | 'helper_slack.credential_missing'
  | 'helper_slack.mount_required'
  | 'budget_syntax_invalid'
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
  | 'lease_exceeded'
  | 'unsupported_completion'
  | 'unsupported_gate'
  | 'unsupported_header'
  | 'unsettled_derived_work'
  | 'unsupported_promise_lifecycle'
  | 'unsupported_workspace_permission'
  | 'unbounded_subscription'
  | 'activity_closed'
  | 'subscription_suspended'
  | 'unawaited_step'
  | 'unsupported_verb';

export class AuthoredFlowExecutionError extends Error {
  constructor(
    readonly code: AuthoredFlowExecutionErrorCode,
    message: string,
    readonly completionReason?: ProtocolCompletionReason | ProtocolRunCompletionReason,
    readonly runId?: string,
    readonly suspension?: AuthoredFlowSuspension,
  ) {
    super(`${code}: ${message}`);
    this.name = 'AuthoredFlowExecutionError';
  }
}

/** Serialized into the CLI report so Cloud can atomically finish activation or wait for a wake. */
export type AuthoredFlowSuspension =
  /**
   * Exact durable `subscription.prepared` facts Cloud must persist before it
   * fences provider ingress and invokes `subscription.activate`. Binding
   * generation and ingress cursor are Cloud-assigned receipts, deliberately
   * absent from the authored request.
   */
  | {
    readonly kind: 'activation';
    readonly subscriptionId: string;
    readonly eventTypes: readonly string[];
    readonly pattern?: Readonly<Record<string, unknown>>;
    readonly stream: string;
    readonly settleMs: number;
    readonly idleMs: number;
    readonly deadlineAtMs: number;
    readonly includeSelf: boolean;
  }
  | {
    readonly kind: 'event_wait';
    readonly subscriptionId: string;
    readonly stream: string;
    readonly deadlineAtMs: number;
  };
