import type { HumanRecipient } from './human-to.js';
import type { StepFailedDetails } from './failure-kinds.js';
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
  | 'gate_failed'
  /** The body reached an unanswered `f.human`; the root parked on it. */
  | 'human_parked'
  /** A recorded answer to `f.human` was not `{ answer: boolean }`. */
  | 'human_answer_invalid'
  /** `f.human`'s `to` is not one of the documented recipient forms (human-to.ts). */
  | 'human_to_invalid'
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
  /** Set by the durable root driver after the child error crosses any IPC boundary. */
  rootRunId?: string;
  constructor(
    readonly code: AuthoredFlowExecutionErrorCode,
    message: string,
    readonly completionReason?: ProtocolCompletionReason | ProtocolRunCompletionReason,
    /**
     * The CHILD run whose journal holds the evidence — an authored operation
     * is its own single-step kernel run. Unchanged by `details`: the root run
     * identity and the failing child identity stay distinct fields.
     */
    readonly runId?: string,
    /**
     * What the failed step left in its journal, already extracted and bounded
     * by `cli/step-failure.ts`. Carried structurally, not only rendered into
     * `message`, so `authoredStepFailure` can lift it into the machine-readable
     * `RunDiagnostic` (which already `extends StepFailedDetails`) and so every
     * wrapper on the way out — the `lease_exceeded` remap, the authenticated
     * Node-child error frame — can forward it instead of dropping it.
     */
    readonly details?: StepFailedDetails,
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
/** The question an authored body parked on, as the kernel journals it. */
export interface AuthoredHumanWait {
  readonly waitId: string;
  readonly question: string;
  readonly to: string;
  /** `to` parsed into its delivery form (human-to.ts); Cloud delivers by it. */
  readonly recipient?: HumanRecipient;
}

/**
 * Thrown by `f.human` when no answer is journaled yet. Not a failure: the
 * durable root catches it, parks its attempt on the kernel's `wait.human`, and
 * the CLI reports exit 3 naming the question and the command that answers it.
 * A resumed body re-runs to the same call and finds the recorded answer.
 */
export class AuthoredHumanParked extends AuthoredFlowExecutionError {
  constructor(readonly wait: AuthoredHumanWait, rootRunId: string) {
    super(
      'human_parked',
      `flow is waiting for ${wait.to} to answer ${JSON.stringify(wait.question)} (${wait.waitId})`,
      undefined,
      rootRunId,
    );
    this.name = 'AuthoredHumanParked';
  }
}
