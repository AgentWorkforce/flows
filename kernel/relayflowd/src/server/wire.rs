use relayflowd_core::{Budget, CompletionReason, EffectRef, Pins, StepType};
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
    #[serde(default)]
    pub pins: Pins,
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

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
pub(super) struct EventEmitParams {
    pub run_id: String,
    pub event_key: String,
    pub payload: Value,
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
pub(super) struct JournalReadParams {
    pub run_id: String,
    pub from_seq: Option<i64>,
    pub limit: Option<usize>,
}
