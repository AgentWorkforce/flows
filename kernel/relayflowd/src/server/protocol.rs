//! Wire response construction and typed protocol error mapping.

use std::{path::Path, sync::Arc};

use relayflowd_core::SpecError;
use serde::{Serialize, de::DeserializeOwned};
use serde_json::Value;

use super::{
    Engine, ProtocolHub, Request, Response, SharedWriter, handle_request, wire::ProtocolError,
};

pub(super) type ProtocolResult<T> = std::result::Result<T, (&'static str, String)>;

pub(super) fn handle_line(
    data_dir: &Path,
    hub: &Arc<ProtocolHub>,
    connection_id: u64,
    writer: &SharedWriter,
    line: &str,
) -> Response {
    let request: Request = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => return error_response(Value::Null, "bad_request", error.to_string()),
    };
    let id = request.id.clone();
    match handle_request(data_dir, hub, connection_id, writer, request) {
        Ok(result) => Response {
            id,
            ok: true,
            result: Some(result),
            error: None,
        },
        Err((code, message)) => error_response(id, code, message),
    }
}

pub(super) fn decode_params<T: DeserializeOwned>(params: Value) -> ProtocolResult<T> {
    serde_json::from_value(params).map_err(|error| ("bad_request", error.to_string()))
}

pub(super) fn to_value(value: impl Serialize) -> ProtocolResult<Value> {
    serde_json::to_value(value).map_err(|error| internal_error(error.into()))
}

pub(super) fn protocol_conflict(error: anyhow::Error) -> (&'static str, String) {
    ("lease_conflict", error.to_string())
}

pub(super) fn ensure_mutable(engine: &Engine, run_id: &str) -> ProtocolResult<()> {
    engine.ensure_run_mutable(run_id).map_err(mutation_error)
}

fn mutation_error(error: anyhow::Error) -> (&'static str, String) {
    if error
        .downcast_ref::<crate::engine::RunTerminalError>()
        .is_some()
    {
        ("run_terminal", error.to_string())
    } else {
        internal_error(error)
    }
}

pub(super) fn run_start_error(error: anyhow::Error) -> (&'static str, String) {
    if let Some(reuse) = error.downcast_ref::<crate::engine::ReuseError>() {
        (reuse.code, reuse.detail.clone())
    } else if error.downcast_ref::<SpecError>().is_some() {
        ("invalid_spec", format!("{error:#}"))
    } else {
        internal_error(error)
    }
}

pub(super) fn internal_error(error: anyhow::Error) -> (&'static str, String) {
    let journal_failure = error.chain().any(|cause| {
        cause.is::<relayflowd_core::JournalError>()
            || cause.is::<relayflowd_journal::JournalStoreError>()
    });
    let code = if journal_failure {
        "journal_write_failed"
    } else {
        "internal"
    };
    (code, format!("{error:#}"))
}

pub(super) fn error_response(id: Value, code: &str, message: String) -> Response {
    Response {
        id,
        ok: false,
        result: None,
        error: Some(ProtocolError {
            code: code.to_owned(),
            message,
        }),
    }
}

pub(super) fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}
