use relayflowd_core::{
    Budget, CompletionReason, EffectRef, Pins, StepType, SubscriptionCompletionReason,
};
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct Request {
    pub id: Value,
    pub verb: String,
    #[serde(default)]
    pub params: Value,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct Response {
    pub id: Value,
    pub ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub error: Option<ProtocolError>,
}

#[derive(Debug, Serialize, Deserialize)]
pub(super) struct ProtocolError {
    pub code: String,
    pub message: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct HelloParams {
    pub protocol: u32,
    #[allow(dead_code)]
    pub client: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RunStartParams {
    pub spec: Value,
    pub reuse_from_run_id: Option<String>,
    pub admission_key: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RunResumeParams {
    pub run_id: String,
    #[serde(default)]
    pub allow_human_influenced: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct RunIdParams {
    pub run_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct WorkerAttachParams {
    pub worker_id: String,
    pub step_types: Vec<StepType>,
    #[serde(default = "default_worker_capacity")]
    pub capacity: usize,
    #[serde(default)]
    pub pins: Pins,
}

fn default_worker_capacity() -> usize {
    1
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StepHeartbeatParams {
    pub run_id: String,
    pub step_id: String,
    pub attempt: u32,
    pub lease_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StepCompleteParams {
    #[serde(default)]
    pub human_intervention: bool,
    pub run_id: String,
    pub step_id: String,
    pub attempt: u32,
    pub idempotency_key: String,
    #[serde(rename = "completionReason")]
    pub completion_reason: CompletionReason,
    #[serde(default)]
    pub output: Value,
    #[serde(default)]
    pub usage: Budget,
    #[serde(default)]
    pub started_pins: Option<Pins>,
    #[serde(default)]
    pub end_pins: Option<Pins>,
    #[serde(default)]
    pub effects: Vec<EffectRef>,
    #[serde(default)]
    pub trajectory_tail: Option<Value>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EffectRecordParams {
    pub run_id: String,
    pub step_id: String,
    pub attempt: u32,
    pub idempotency_key: String,
    pub surface_path: String,
    pub revision_before: String,
    pub revision_after: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EffectConfirmParams {
    pub run_id: String,
    pub step_id: String,
    pub attempt: u32,
    pub idempotency_key: String,
    pub surface_path: String,
}

/// A lease holder parks its running attempt on a durable human question
/// (`wait.human`, DESIGN.md §1.5). The lease is released once the wait is
/// journaled; the answer arrives through `event.emit` keyed by `wait_id`.
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StepWaitParams {
    pub run_id: String,
    pub step_id: String,
    pub attempt: u32,
    pub idempotency_key: String,
    pub wait_id: String,
    pub prompt: String,
    pub requested_of: String,
    #[serde(default)]
    pub options: Option<Vec<String>>,
    #[serde(default)]
    pub timeout_at_ms: Option<i64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SubscriptionParkParams {
    pub run_id: String,
    pub step_id: String,
    pub attempt: u32,
    pub idempotency_key: String,
    pub subscription_id: String,
    pub phase: crate::engine::SubscriptionWaitPhase,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EventEmitParams {
    pub run_id: String,
    pub event_key: String,
    pub payload: Value,
    #[serde(default)]
    pub delivery_id: Option<String>,
    #[serde(default)]
    pub actor: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EventSubmitParams {
    pub spec: Value,
    pub event: relayflowd_core::Event,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StreamAppendParams {
    pub run_id: String,
    pub stream: String,
    pub message: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct StreamReadParams {
    pub run_id: String,
    pub stream: String,
    pub from_offset: u64,
    pub limit: Option<usize>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SubscriptionOpenParams {
    pub run_id: String,
    pub subscription_id: String,
    pub event_types: Vec<String>,
    #[serde(default)]
    pub pattern: Option<Value>,
    pub settle_ms: i64,
    pub idle_ms: i64,
    pub deadline_ms: i64,
    pub include_self: bool,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SubscriptionNextParams {
    pub run_id: String,
    pub subscription_id: String,
    #[serde(default)]
    pub acknowledge_wait_id: Option<String>,
    #[serde(default)]
    pub sequence: Option<u64>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SubscriptionActivateParams {
    pub run_id: String,
    pub subscription_id: String,
    pub ingress_offset: u64,
    pub router_binding: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SubscriptionInspectParams {
    pub run_id: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SubscriptionFenceOverflowParams {
    pub run_id: String,
    pub subscription_id: String,
    pub router_binding: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SubscriptionDeliverParams {
    pub run_id: String,
    pub subscription_id: String,
    pub router_binding: Value,
    pub delivery_id: String,
    pub frame: Value,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct SubscriptionCloseParams {
    pub run_id: String,
    pub subscription_id: String,
    pub completion_reason: SubscriptionCompletionReason,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct JournalReadParams {
    pub run_id: String,
    pub from_seq: Option<i64>,
    pub limit: Option<usize>,
}
