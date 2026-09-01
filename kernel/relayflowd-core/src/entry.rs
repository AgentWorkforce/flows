use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::spec::{RecoveryMode, StepType};

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
pub enum EntryType {
    #[serde(rename = "run.spawned")]
    RunSpawned,
    #[serde(rename = "event.received")]
    EventReceived,
    #[serde(rename = "subscription.registered")]
    SubscriptionRegistered,
    #[serde(rename = "subscription.matched")]
    SubscriptionMatched,
    /// The sweep noticed a subscription's `last_event_at_ms` fell farther
    /// behind wall-clock than its declared `stale_after_ms`. Emitted at
    /// least once per silence — a re-arrival re-arms the latch, and a
    /// crash between journal-append and latch can cause re-emission of
    /// the same silence with a different `detected_at_ms`. The RFC's
    /// "Native silent-death" answer at the journal level.
    #[serde(rename = "subscription.stale")]
    SubscriptionStale,
    #[serde(rename = "step.attempt.started")]
    StepAttemptStarted,
    #[serde(rename = "step.completed")]
    StepCompleted,
    #[serde(rename = "wait.event")]
    WaitEvent,
    #[serde(rename = "wait.human")]
    WaitHuman,
    #[serde(rename = "sleep.until")]
    SleepUntil,
    #[serde(rename = "wait.completed")]
    WaitCompleted,
    #[serde(rename = "stream.appended")]
    StreamAppended,
    #[serde(rename = "effect.recorded")]
    EffectRecorded,
    #[serde(rename = "effect.confirmed")]
    EffectConfirmed,
    #[serde(rename = "epoch.summary")]
    EpochSummary,
    #[serde(rename = "segment.closed")]
    SegmentClosed,
    #[serde(rename = "run.completed")]
    RunCompleted,
}

impl EntryType {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::RunSpawned => "run.spawned",
            Self::EventReceived => "event.received",
            Self::SubscriptionRegistered => "subscription.registered",
            Self::SubscriptionMatched => "subscription.matched",
            Self::SubscriptionStale => "subscription.stale",
            Self::StepAttemptStarted => "step.attempt.started",
            Self::StepCompleted => "step.completed",
            Self::WaitEvent => "wait.event",
            Self::WaitHuman => "wait.human",
            Self::SleepUntil => "sleep.until",
            Self::WaitCompleted => "wait.completed",
            Self::StreamAppended => "stream.appended",
            Self::EffectRecorded => "effect.recorded",
            Self::EffectConfirmed => "effect.confirmed",
            Self::EpochSummary => "epoch.summary",
            Self::SegmentClosed => "segment.closed",
            Self::RunCompleted => "run.completed",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        Some(match value {
            "run.spawned" => Self::RunSpawned,
            "event.received" => Self::EventReceived,
            "subscription.registered" => Self::SubscriptionRegistered,
            "subscription.matched" => Self::SubscriptionMatched,
            "subscription.stale" => Self::SubscriptionStale,
            "step.attempt.started" => Self::StepAttemptStarted,
            "step.completed" => Self::StepCompleted,
            "wait.event" => Self::WaitEvent,
            "wait.human" => Self::WaitHuman,
            "sleep.until" => Self::SleepUntil,
            "wait.completed" => Self::WaitCompleted,
            "stream.appended" => Self::StreamAppended,
            "effect.recorded" => Self::EffectRecorded,
            "effect.confirmed" => Self::EffectConfirmed,
            "epoch.summary" => Self::EpochSummary,
            "segment.closed" => Self::SegmentClosed,
            "run.completed" => Self::RunCompleted,
            _ => return None,
        })
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct JournalEntry {
    /// Zero before persistence; the journal assigns a positive sequence.
    pub seq: i64,
    pub segment_id: i64,
    pub entry_type: EntryType,
    pub run_id: String,
    pub step_id: Option<String>,
    pub attempt: Option<u32>,
    pub at_ms: i64,
    pub payload: Value,
}

impl JournalEntry {
    pub fn new<T: Serialize>(
        entry_type: EntryType,
        run_id: impl Into<String>,
        step_id: Option<String>,
        attempt: Option<u32>,
        at_ms: i64,
        payload: T,
    ) -> Self {
        Self {
            seq: 0,
            segment_id: 0,
            entry_type,
            run_id: run_id.into(),
            step_id,
            attempt,
            at_ms,
            payload: serde_json::to_value(payload).expect("journal payload must serialize"),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RunSpawnedPayload {
    pub spec: Value,
    pub spec_hash: String,
    pub parent_run_id: Option<String>,
    pub journal_version: u32,
    pub created_by: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct AttemptStartedPayload {
    pub step_type: StepType,
    pub idempotency_key: String,
    pub lease_id: String,
    pub lease_deadline_ms: i64,
    pub executor: String,
    pub recovery_mode: Option<RecoveryMode>,
    pub pins: Pins,
    pub max_iterations: u32,
}

/// Runtime pins journaled per attempt (RFC Appendix A rules 2 and 6): the
/// revision id of each declared workspace surface and the offset of each
/// declared stream. Pins are journal facts, never spec fields — the spec only
/// *declares* surfaces (rule 1).
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct Pins {
    #[serde(default)]
    pub workspace: Vec<WorkspacePin>,
    #[serde(default)]
    pub streams: Vec<StreamPin>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct WorkspacePin {
    pub surface: String,
    pub revision_id: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StreamPin {
    pub stream: String,
    pub read_offset: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum CompletionReason {
    Success,
    VerificationFailed,
    RetriesExhausted,
    LeaseExpired,
    Crashed,
    Timeout,
    WorkerError,
    BudgetExceeded,
    Canceled,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum Disposition {
    StepDone,
    Retry,
    Park,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StepCompletedPayload {
    #[serde(rename = "completionReason")]
    pub completion_reason: CompletionReason,
    pub disposition: Disposition,
    pub output: Value,
    pub verification: Option<VerificationRecord>,
    pub end_pins: Option<Pins>,
    #[serde(default)]
    pub effects: Vec<EffectRef>,
    /// Worker-supplied execution context for `inspect` recovery. This is
    /// evidence from the failed attempt, not a command to replay it. The
    /// protocol boundary that admits it (`step.complete`) caps its size; the
    /// journal itself stores whatever was admitted.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub trajectory_tail: Option<Value>,
    #[serde(default)]
    pub budget: Budget,
    pub completed_by: String,
    pub next_attempt_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct VerificationRecord {
    pub gate: String,
    pub verdict: VerificationVerdict,
    pub detail: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum VerificationVerdict {
    Pass,
    Fail,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EffectRef {
    pub surface_path: String,
    pub idempotency_key: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Budget {
    #[serde(default)]
    pub tokens_in: u64,
    #[serde(default)]
    pub tokens_out: u64,
    #[serde(default = "zero_dollars")]
    pub dollars: String,
}

impl Default for Budget {
    fn default() -> Self {
        Self {
            tokens_in: 0,
            tokens_out: 0,
            dollars: zero_dollars(),
        }
    }
}

fn zero_dollars() -> String {
    "0".to_owned()
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SleepUntilPayload {
    pub wait_id: String,
    pub wake_at_ms: i64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WaitEventPayload {
    pub wait_id: String,
    pub event_key: String,
    pub timeout_at_ms: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WaitHumanPayload {
    pub wait_id: String,
    pub prompt: String,
    pub requested_of: String,
    pub options: Option<Vec<String>>,
    pub timeout_at_ms: Option<i64>,
    pub diff_ref: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum WaitCompletionReason {
    EventReceived,
    HumanResponded,
    TimerFired,
    Timeout,
    Canceled,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct WaitCompletedPayload {
    pub wait_id: String,
    #[serde(rename = "completionReason")]
    pub completion_reason: WaitCompletionReason,
    pub result: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StreamAppendedPayload {
    pub stream: String,
    pub offset: u64,
    pub producer: String,
    pub message: Value,
}

/// Appendix A rule 5. The record *elects* one attempt to perform the
/// writeback; this entry says the elected attempt performed it. Until it
/// exists the election is provisional, and a later attempt may reclaim it —
/// otherwise a worker that died between electing and calling the provider
/// would suppress an effect that never happened.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EffectConfirmedPayload {
    pub surface_path: String,
    pub idempotency_key: String,
    pub agent_identity: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct EffectRecordedPayload {
    pub surface_path: String,
    pub idempotency_key: String,
    pub revision_before: String,
    pub revision_after: String,
    pub agent_identity: String,
    /// True when a *confirmed* election already covers this
    /// `(step_id, idempotency_key, surface_path)`: the writeback has provably
    /// happened, so this attempt must not call the provider. An election that
    /// was never confirmed does not dedupe — this attempt reclaims it.
    pub deduped: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EpochSummaryPayload {
    pub epoch: i64,
    pub prev_segment_id: i64,
    pub journal_version: u32,
    #[serde(default)]
    pub steps_done: BTreeMap<String, StepDoneSummary>,
    #[serde(default)]
    pub steps_open: BTreeMap<String, StepOpenSummary>,
    #[serde(default)]
    pub open_waits: BTreeMap<String, Value>,
    #[serde(default)]
    pub stream_state: BTreeMap<String, StreamSummary>,
    #[serde(default)]
    pub pinned_revisions: BTreeMap<String, String>,
    #[serde(default)]
    pub budget_spent: Budget,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StepDoneSummary {
    #[serde(rename = "completionReason")]
    pub completion_reason: CompletionReason,
    pub output: Value,
}

/// An unfinished step carried across an epoch boundary. Each state uses its
/// own field: `running` carries the lease deadline and idempotency key,
/// `backoff` carries the wake time — no field is overloaded across states.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct StepOpenSummary {
    pub attempt: u32,
    pub state: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub lease_deadline_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub wake_at_ms: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub idempotency_key: Option<String>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
pub struct StreamSummary {
    pub length: u64,
    #[serde(default)]
    pub consumers: BTreeMap<String, u64>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SegmentClosedPayload {
    pub next_segment_id: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RunCompletionReason {
    Success,
    StepFailed,
    Canceled,
    BudgetExceeded,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RunCompletedPayload {
    #[serde(rename = "completionReason")]
    pub completion_reason: RunCompletionReason,
    pub failed_step_id: Option<String>,
    pub budget_total: Budget,
}
