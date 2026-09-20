import type {
  Activity,
  ActivityDuration,
  ActivityOptions,
  EventFrame,
  TriggerSource,
  WebhookTriggerSource,
  Wake,
} from '@relayflows/surface';
import type { SubscriptionNextResult } from './protocol.js';
import { AuthoredFlowExecutionError, type AuthoredFlowSuspension } from './authored-flow-error.js';
import { JournalClient } from './journal-client.js';

type CloseReason = 'closed' | 'run_completed' | 'canceled';

interface OpenActivity {
  readonly activity: Activity;
  close(reason: CloseReason): Promise<void>;
}

/** Owns body-local cursors that must close before the authored root completes. */
export class AuthoredActivities {
  private readonly activities: OpenActivity[] = [];

  constructor(
    private readonly journal: JournalClient,
    private readonly runId: string | undefined,
  ) {}

  open(source: TriggerSource, options: ActivityOptions): Activity {
    if (source?.kind !== 'webhook') {
      throw new AuthoredFlowExecutionError('unsupported_header',
        'f.on() requires an event source; schedule triggers start runs and cannot be awaited inside a body');
    }
    if (this.runId === undefined) {
      throw new AuthoredFlowExecutionError('journal_protocol_violation', 'f.on() requires a durable authored root run');
    }
    const id = `activity-${this.activities.length + 1}`;
    const activity = new JournalActivity(this.journal, this.runId, id, source, normalizeOptions(options));
    this.activities.push(activity);
    return activity.activity;
  }

  async closeAll(reason: Exclude<CloseReason, 'closed'>): Promise<void> {
    for (const activity of this.activities) await activity.close(reason);
  }
}

class JournalActivity implements OpenActivity {
  readonly activity: Activity;
  private readonly openPromise: Promise<void>;
  private closed = false;
  private nextSequence = 0;
  private acknowledgeWaitId: string | undefined;

  constructor(
    private readonly journal: JournalClient,
    private readonly runId: string,
    private readonly subscriptionId: string,
    private readonly source: WebhookTriggerSource,
    private readonly options: NormalizedActivityOptions,
  ) {
    this.activity = Object.freeze({
      next: () => this.next(),
      close: () => this.close('closed'),
    });
    // Opening starts at f.on(), rather than at the first next(), so frames
    // arriving while the body reads state or runs another step are inside the
    // router's binding window. next()/close() await this same handshake.
    this.openPromise = this.openNow();
    void this.openPromise.catch(() => undefined);
  }

  async close(reason: CloseReason): Promise<void> {
    if (this.closed) return;
    try {
      await this.ensureOpen();
    } catch (error) {
      // Failure cleanup has no active binding to close before activation.
      // Re-throwing this handoff would disguise a real body failure as a
      // normal suspension. Root termination fences any later activation.
      if (reason !== 'closed' && error instanceof AuthoredFlowExecutionError
        && error.code === 'subscription_suspended' && error.suspension?.kind === 'activation') return;
      throw error;
    }
    await this.journal.subscriptionClose({
      run_id: this.runId,
      subscription_id: this.subscriptionId,
      completion_reason: reason,
    });
    this.closed = true;
  }

  private async next(): Promise<Wake> {
    if (this.closed) throw new AuthoredFlowExecutionError('activity_closed', 'activity is already closed');
    await this.ensureOpen();
    const result = await this.journal.subscriptionNext({
      run_id: this.runId,
      subscription_id: this.subscriptionId,
      sequence: this.nextSequence,
      ...(this.acknowledgeWaitId === undefined ? {} : { acknowledge_wait_id: this.acknowledgeWaitId }),
    });
    if (result.kind === 'suspended') {
      throw suspended({
        kind: 'event_wait', subscriptionId: result.subscription_id,
        stream: result.stream, deadlineAtMs: result.deadline_at_ms,
      }, this.runId);
    }
    const wake = decodeWake(result);
    if (wake.kind === 'deadline' || wake.kind === 'overflow') {
      this.closed = true;
    } else {
      this.acknowledgeWaitId = receiptId(result) ?? `${this.subscriptionId}/next/${this.nextSequence}`;
      this.nextSequence += 1;
    }
    return wake;
  }

  private async ensureOpen(): Promise<void> {
    await this.openPromise;
  }

  private async openNow(): Promise<void> {
    const result = await this.journal.subscriptionOpen({
      run_id: this.runId,
      subscription_id: this.subscriptionId,
      event_types: [this.source.name],
      ...(this.source.filter === undefined ? {} : { pattern: this.source.filter }),
      settle_ms: this.options.settleMs,
      idle_ms: this.options.idleMs,
      deadline_ms: this.options.deadlineMs,
      include_self: this.options.includeSelf,
    });
    if (result.state === 'prepared') {
      throw suspended({
        kind: 'activation', subscriptionId: result.subscription_id,
        eventTypes: Object.freeze([...result.event_types]),
        ...(result.pattern === undefined ? {} : { pattern: Object.freeze({ ...result.pattern }) }),
        stream: result.stream, settleMs: result.settle_ms, idleMs: result.idle_ms,
        deadlineAtMs: result.deadline_at_ms, includeSelf: result.include_self,
      }, this.runId);
    }
  }
}

function suspended(value: AuthoredFlowSuspension, runId: string): AuthoredFlowExecutionError {
  return new AuthoredFlowExecutionError(
    'subscription_suspended',
    `subscription ${value.subscriptionId} is durably suspended for ${value.kind}`,
    undefined,
    runId,
    value,
  );
}

function receiptId(result: SubscriptionNextResult): string | undefined {
  const receipt = (result as { acknowledge_wait_id?: unknown }).acknowledge_wait_id;
  return typeof receipt === 'string' && receipt.length > 0 ? receipt : undefined;
}

interface NormalizedActivityOptions {
  readonly settleMs: number;
  readonly idleMs: number;
  readonly deadlineMs: number;
  readonly includeSelf: boolean;
}

function normalizeOptions(options: ActivityOptions): NormalizedActivityOptions {
  if (typeof options !== 'object' || options === null || Array.isArray(options)) {
    throw unboundedSubscription('f.on() requires idle and deadline bounds');
  }
  const value = options as unknown as Record<string, unknown>;
  const allowed = new Set(['settle', 'idle', 'deadline', 'includeSelf']);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw new AuthoredFlowExecutionError('unbounded_subscription', `f.on() has unknown option ${JSON.stringify(key)}`);
  }
  if (!Object.hasOwn(value, 'idle') || !Object.hasOwn(value, 'deadline')) {
    throw unboundedSubscription('f.on() requires both idle and deadline bounds');
  }
  if (value['includeSelf'] !== undefined && typeof value['includeSelf'] !== 'boolean') {
    throw new AuthoredFlowExecutionError('unbounded_subscription', 'f.on() includeSelf must be a boolean');
  }
  return Object.freeze({
    settleMs: parseDuration(value['settle'] as ActivityDuration | undefined, 'settle', true),
    idleMs: parseDuration(value['idle'] as ActivityDuration, 'idle', false),
    deadlineMs: parseDuration(value['deadline'] as ActivityDuration, 'deadline', false),
    includeSelf: value['includeSelf'] === true,
  });
}

function parseDuration(value: ActivityDuration | undefined, field: string, zeroAllowed: boolean): number {
  if (value === undefined && zeroAllowed) return 0;
  let milliseconds: number;
  if (typeof value === 'number') milliseconds = value;
  else if (typeof value === 'string') {
    const match = /^(\d+(?:\.\d+)?)(ms|s|m|h|d)$/.exec(value);
    const units: Record<string, number> = { ms: 1, s: 1_000, m: 60_000, h: 3_600_000, d: 86_400_000 };
    const unit = match?.[2];
    milliseconds = match === null || unit === undefined ? NaN : Math.round(Number(match[1]) * units[unit]!);
  } else milliseconds = NaN;
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0 || (!zeroAllowed && milliseconds === 0)) {
    throw new AuthoredFlowExecutionError(
      'unbounded_subscription',
      `f.on() ${field} must be ${zeroAllowed ? 'a non-negative' : 'a positive'} whole number of milliseconds or a duration such as "72h"`,
    );
  }
  return milliseconds;
}

function unboundedSubscription(message: string): AuthoredFlowExecutionError {
  return new AuthoredFlowExecutionError('unbounded_subscription', message);
}

/** Decode the wire result at the journal boundary so malformed wakes fail closed. */
export function decodeWake(value: SubscriptionNextResult): Wake {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return invalidWake();
  if (value.kind === 'idle') return Object.freeze({ kind: 'idle' });
  if (value.kind === 'events') {
    if (!Array.isArray(value.events) || !isOffset(value.offset) || !value.events.every(isEventFrame)) return invalidWake();
    return Object.freeze({ kind: 'events', events: Object.freeze([...value.events]) as readonly EventFrame[], offset: value.offset });
  }
  if (value.kind === 'deadline') {
    if (value.pending !== null && !isPending(value.pending)) return invalidWake();
    return Object.freeze({ kind: 'deadline', pending: value.pending === null ? null : Object.freeze({ ...value.pending }) });
  }
  if (value.kind === 'overflow') {
    if (!isOffset(value.retained) || !isOffset(value.bytes) || !isOffset(value.from)) return invalidWake();
    return Object.freeze({ kind: 'overflow', retained: value.retained, bytes: value.bytes, from: value.from });
  }
  return invalidWake();
}

function isEventFrame(value: unknown): value is EventFrame {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && typeof (value as { type?: unknown }).type === 'string';
}

function isPending(value: unknown): value is { from: number; to: number } {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && isOffset((value as { from?: unknown }).from)
    && isOffset((value as { to?: unknown }).to);
}

function isOffset(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function invalidWake(): never {
  throw new AuthoredFlowExecutionError('journal_protocol_violation', 'subscription.next returned an invalid wake result');
}
