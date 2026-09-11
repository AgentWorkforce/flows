// Journal protocol v0 — the SDK boundary (kernel DESIGN.md §5).
//
// Transport: newline-delimited JSON over a unix socket at
// `<data-dir>/relayflowd.sock`. Requests `{id, verb, params}`; responses
// `{id, ok: true, result}` or `{id, ok: false, error: {code, message}}`;
// server-pushed events `{event, data}` (no `id`). Any verb whose journal
// append fails returns `error{code: "journal_write_failed"}` and the affected
// step fails — the protocol is fail-closed like everything behind it.
//
// This module is the typed wire surface; `journal-client.ts` implements it.

import type { KernelRunSpec, KernelMemorySpec, StepType } from './spec.js';

/** Stamped per segment; readers read every past version, writers write newest. */
export const PROTOCOL_VERSION = 0 as const;

/** A journal append that fails fails the step (AGENTS.md rule 4). */
export const JOURNAL_WRITE_FAILED = 'journal_write_failed' as const;

export type ProtocolError = { code: string; message: string };

/** Client -> server. */
export interface Request<P = unknown> {
  id: string;
  verb: string;
  params: P;
}

/** Server -> client response, correlated by `id`. */
export type Response<R = unknown> =
  | { id: string; ok: true; result: R }
  | { id: string; ok: false; error: ProtocolError };

/** Server -> client push (no `id`). */
export interface ServerEvent {
  event: string;
  data: unknown;
}

// --- Verb set (gate 1 minimal) ---------------------------------------------
// Verb names mirror kernel DESIGN.md §5 verbatim.

export type Verb =
  | 'hello'
  | 'run.start'
  | 'run.resume'
  | 'run.cancel'
  | 'run.get'
  | 'run.watch'
  | 'worker.attach'
  | 'step.heartbeat'
  | 'effect.record'
  | 'effect.confirm'
  | 'step.complete'
  | 'event.emit'
  | 'event.submit'
  | 'stream.append'
  | 'stream.read'
  | 'journal.read';

// --- Typed params / results -------------------------------------------------

export interface HelloParams {
  protocol: 0;
  client: string;
}
export interface HelloResult {
  protocol: 0;
  server: string;
}

export interface RunStartParams {
  /**
   * The kernel spec dialect — the ONE boundary shape `RunSpec::parse`
   * accepts (snake_case, flat v0 verification, defaults materialized).
   * The authoring `FlowSpec` never crosses the wire; `JournalClient.runStart`
   * converts via `toKernelSpec`.
   */
  spec: KernelRunSpec;
}
export type RunStatus = 'running' | 'completed' | 'failed' | 'interrupted' | 'parked';
export type RunCompletionReason = 'success' | 'step_failed' | 'canceled' | 'budget_exceeded';

export interface RunOutcome {
  run_id: string;
  status: RunStatus;
  completion_reason: RunCompletionReason | null;
  completed_steps: number;
}
export type RunStartResult = RunOutcome;

export interface RunResumeParams {
  run_id: string;
}
export type RunResumeResult = RunOutcome;

export interface RunCancelParams {
  run_id: string;
}
export type RunCancelResult = RunOutcome;

export interface RunGetParams {
  run_id: string;
}
export type StepStatus =
  | 'pending'
  | 'runnable'
  | 'running'
  | 'backoff'
  | 'waiting'
  | 'needs_human'
  | 'done';
export interface StepSnapshot {
  type: StepType;
  state: StepStatus;
  lease_deadline_ms?: number;
}
export interface RunGetResult {
  run_id: string;
  status: RunStatus;
  steps: Record<string, StepSnapshot>;
  budget: { tokens_in: number; tokens_out: number; dollars: string };
}

export interface RunWatchParams {
  run_id: string;
}
export interface RunWatchResult {
  watching: string;
}
/** `run.watch` opens a push stream of `{event: "entry", data: Entry}`. */

export interface WorkerAttachParams {
  worker_id: string;
  step_types: StepType[];
  /** Maximum concurrent assignments. Omitted means the conservative default 1. */
  capacity?: number;
  /**
   * The surfaces this worker holds, as opaque revisions/offsets. Required when
   * `step_types` includes `agent` — an agent attempt's start pins come from
   * here (Appendix A rule 2), so an agent worker with no pins is refused at
   * attach rather than failing in the middle of a run.
   */
  pins?: Pins;
}
export interface WorkerAttachResult {
  worker_id: string;
}
/**
 * Wake-context payload assembled kernel-side at `subscription.matched`.
 * The two fields typed below are the ones every current consumer keys
 * against; additional kernel-side fields flow through as extra
 * properties without breaking this type.
 */
export interface WakeContext {
  triggering_event?: {
    type: string;
    payload?: unknown;
  };
  epoch_summary?: {
    open_steps?: string[];
  };
  [additionalKernelFields: string]: unknown;
}

/** Server then pushes `step.dispatch` events to the attached worker. */
export interface MemoryInjectedPayload {
  request: KernelMemorySpec;
  pack: unknown;
  budget: { tokens_in: number; tokens_out: number; dollars: string };
  provider: string;
}

export interface RoutingDecision {
  profile: string;
  provider: string;
  fallbacks_attempted: string[];
  workspace?: string;
}

export interface StepDispatchEvent {
  /** Selected successful outputs, resolved by the kernel from the journal. */
  input?: Record<string, unknown>;
  /** Durable choice; optional only for older kernel protocol compatibility. */
  routing?: RoutingDecision;
  /** Already journaled and charged; completion usage excludes this cost. */
  memory?: MemoryInjectedPayload;
  run_id: string;
  step_id: string;
  attempt: number;
  step_type: StepType;
  spec: unknown;
  lease_id: string;
  idempotency_key: string;
  pins: Pins;
  /**
   * The `wake_context` payload from the run's `subscription.matched`
   * journal entry — carries the triggering event and any epoch summary
   * the flow needs to know why this step is running. Present when the
   * run was spawned by an event; `undefined` for runs started directly
   * (no trigger fired). A real agent needs this to see the event
   * payload (e.g. the HN story ID).
   *
   * Shape is assembled kernel-side in
   * `kernel/relayflowd/src/engine/wake.rs` (grep for
   * `wake_context` — the Rust field is written with quoted
   * JSON keys so `"wake_context":` hits the assembly site
   * directly). The narrow type below pins the two fields
   * every consumer currently reads —
   * `triggering_event.type`/`payload` and `epoch_summary` — while
   * keeping the container `unknown`-permissive so a kernel-side
   * addition (a new nested field) does not break the SDK type. A
   * kernel-side RENAME of these two fields does break every
   * consumer; that is deliberate and preferable to silent drift.
   */
  wake_context?: WakeContext;
  recovery?: {
    mode: 'reset' | 'inspect' | 'manual';
    restore_pins?: Pins;
    previous_completion_reason?: CompletionReason;
    trajectory_tail?: unknown;
  };
  lease_deadline_ms: number;
}

export interface StepHeartbeatParams {
  run_id: string;
  step_id: string;
  attempt: number;
  lease_id: string;
}
export interface StepHeartbeatResult {
  lease_deadline_ms: number;
}

/** completionReason mirrors kernel DESIGN.md §1.3. */
export type CompletionReason =
  | 'success'
  | 'verification_failed'
  | 'retries_exhausted'
  | 'lease_expired'
  | 'crashed'
  | 'timeout'
  | 'worker_error'
  | 'budget_exceeded'
  | 'canceled';

export interface Pins {
  workspace?: { surface: string; revision_id: string }[];
  streams?: { stream: string; read_offset: number }[];
}

export interface EffectRef {
  surface_path: string;
  idempotency_key: string;
}

export interface EffectRecordParams {
  run_id: string;
  step_id: string;
  attempt: number;
  idempotency_key: string;
  surface_path: string;
  revision_before: string;
  revision_after: string;
}
export interface EffectRecordResult {
  /**
   * True only when a *confirmed* election already covers this
   * `(step_id, idempotency_key, surface_path)`: the writeback provably
   * happened, so this attempt must not call the provider. An election that was
   * never confirmed does not dedupe — this attempt reclaims it and owes the
   * call, which is what keeps an effect from being lost to a worker that died
   * between recording and performing.
   */
  deduped: boolean;
}

/** Phase two: the elected attempt performed the writeback. */
export interface EffectConfirmParams {
  run_id: string;
  step_id: string;
  attempt: number;
  idempotency_key: string;
  surface_path: string;
}
export interface EffectConfirmResult {
  confirmed: string;
}

export interface StepCompleteParams {
  run_id: string;
  step_id: string;
  attempt: number;
  idempotency_key: string;
  completionReason: CompletionReason;
  output?: unknown;
  usage?: { tokens_in: number; tokens_out: number; dollars: string };
  started_pins?: Pins;
  end_pins?: Pins;
  effects?: EffectRef[];
  /** `inspect` evidence for the next attempt. Rejected over 16 KiB of JSON. */
  trajectory_tail?: unknown;
}
export type StepCompleteResult = RunOutcome;

export interface EventEmitParams {
  run_id: string;
  event_key: string;
  payload: unknown;
}
export interface EventEmitResult {
  matched: number;
}

/**
 * Submit an external event to a flow that declares an event trigger. The
 * kernel matches it against the spec's subscriptions and, on a first match,
 * spawns a run; a repeat of the same (flow, subscription, key) is deduped.
 */
export interface EventSubmitParams {
  spec: unknown;
  event: {
    type: string;
    payload?: unknown;
    /** Overrides the subscription's dedupeKeyTemplate when supplied. */
    key?: string;
  };
}
export interface EventSubmitResult {
  matched: boolean;
  deduped: boolean;
  subscription_id?: string | null;
  run?: unknown;
}

export interface StreamAppendParams {
  run_id: string;
  stream: string;
  message: unknown;
}
export interface StreamAppendResult {
  offset: number;
}

export interface StreamReadParams {
  run_id: string;
  stream: string;
  from_offset: number;
  limit?: number;
}
export interface StreamReadResult {
  messages: unknown[];
  next_offset: number;
}

export interface JournalReadParams {
  run_id: string;
  from_seq: number;
  limit?: number;
}
export interface JournalReadResult {
  entries: unknown[];
}

/** Typed map of verb -> { params, result }. Used by the client for type-safety. */
export interface VerbContract {
  hello: { params: HelloParams; result: HelloResult };
  'run.start': { params: RunStartParams; result: RunStartResult };
  'run.resume': { params: RunResumeParams; result: RunResumeResult };
  'run.cancel': { params: RunCancelParams; result: RunCancelResult };
  'run.get': { params: RunGetParams; result: RunGetResult };
  'run.watch': { params: RunWatchParams; result: RunWatchResult };
  'worker.attach': { params: WorkerAttachParams; result: WorkerAttachResult };
  'step.heartbeat': { params: StepHeartbeatParams; result: StepHeartbeatResult };
  'effect.record': { params: EffectRecordParams; result: EffectRecordResult };
  'effect.confirm': { params: EffectConfirmParams; result: EffectConfirmResult };
  'step.complete': { params: StepCompleteParams; result: StepCompleteResult };
  'event.emit': { params: EventEmitParams; result: EventEmitResult };
  'event.submit': { params: EventSubmitParams; result: EventSubmitResult };
  'stream.append': { params: StreamAppendParams; result: StreamAppendResult };
  'stream.read': { params: StreamReadParams; result: StreamReadResult };
  'journal.read': { params: JournalReadParams; result: JournalReadResult };
}
