use std::{io, path::Path};

use anyhow::{Context, Result};
use relayflowd_core::{CompletionReason, PROTOCOL_VERSION, RunSpec};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::{Engine, OutOfBandCompletion};

#[cfg(unix)]
mod session;
#[cfg(unix)]
use session::{ProtocolHub, SharedWriter, write_frame};
mod wire;
use wire::*;

type ProtocolResult<T> = std::result::Result<T, (&'static str, String)>;

#[cfg(unix)]
pub fn serve(data_dir: &Path) -> Result<()> {
    use std::{
        io::{BufRead, BufReader},
        os::unix::net::UnixListener,
        sync::{
            Arc,
            atomic::{AtomicU64, Ordering},
        },
        thread,
    };

    std::fs::create_dir_all(data_dir)?;
    let socket_path = data_dir.join("relayflowd.sock");
    if socket_path.exists() {
        std::fs::remove_file(&socket_path)
            .with_context(|| format!("remove stale socket {}", socket_path.display()))?;
    }
    let listener = UnixListener::bind(&socket_path)
        .with_context(|| format!("bind socket {}", socket_path.display()))?;
    let hub = Arc::new(ProtocolHub::default());
    let next_connection = Arc::new(AtomicU64::new(1));
    for connection in listener.incoming() {
        let connection = connection?;
        let data_dir = data_dir.to_path_buf();
        let hub = hub.clone();
        let connection_id = next_connection.fetch_add(1, Ordering::Relaxed);
        thread::spawn(move || {
            let writer = Arc::new(std::sync::Mutex::new(connection.try_clone()?));
            let reader = BufReader::new(connection);
            for line in reader.lines() {
                let response = match line {
                    Ok(line) => handle_line(&data_dir, &hub, connection_id, &writer, &line),
                    Err(error) => error_response(Value::Null, "bad_request", error.to_string()),
                };
                if write_frame(&writer, &response).is_err() {
                    break;
                }
            }
            let dispatcher: Arc<dyn crate::worker::StepDispatcher> = hub.clone();
            let observer: Arc<dyn crate::worker::JournalObserver> = hub.clone();
            let engine = Engine::with_runtime(&data_dir, dispatcher, observer);
            for lease in hub.detach(connection_id) {
                let _ = engine.abandon_out_of_band(
                    &lease.run_id,
                    &lease.step_id,
                    lease.attempt,
                    CompletionReason::Crashed,
                );
            }
            Ok::<_, anyhow::Error>(())
        });
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn serve(_data_dir: &Path) -> Result<()> {
    anyhow::bail!("journal protocol v0 requires Unix domain sockets")
}

#[cfg(unix)]
fn handle_line(
    data_dir: &Path,
    hub: &std::sync::Arc<ProtocolHub>,
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

#[cfg(unix)]
fn handle_request(
    data_dir: &Path,
    hub: &std::sync::Arc<ProtocolHub>,
    connection_id: u64,
    writer: &SharedWriter,
    request: Request,
) -> ProtocolResult<Value> {
    let dispatcher: std::sync::Arc<dyn crate::worker::StepDispatcher> = hub.clone();
    let observer: std::sync::Arc<dyn crate::worker::JournalObserver> = hub.clone();
    let engine = Engine::with_runtime(data_dir, dispatcher, observer);
    match request.verb.as_str() {
        "hello" => {
            let params: HelloParams = decode_params(request.params)?;
            if params.protocol != PROTOCOL_VERSION {
                return Err((
                    "protocol_mismatch",
                    format!("relayflowd supports protocol {PROTOCOL_VERSION}"),
                ));
            }
            Ok(json!({"protocol": PROTOCOL_VERSION, "server": "relayflowd"}))
        }
        "run.start" => {
            let params: RunStartParams = decode_params(request.params)?;
            let spec = RunSpec::parse(&params.spec)
                .map_err(|error| ("invalid_spec", error.to_string()))?;
            to_value(
                engine
                    .start(spec, "protocol-v0", None)
                    .map_err(internal_error)?,
            )
        }
        "run.resume" => {
            let params: RunIdParams = decode_params(request.params)?;
            to_value(
                engine
                    .resume(&params.run_id, None)
                    .map_err(internal_error)?,
            )
        }
        "run.get" => {
            let params: RunIdParams = decode_params(request.params)?;
            to_value(engine.snapshot(&params.run_id).map_err(internal_error)?)
        }
        "run.watch" => {
            let params: RunIdParams = decode_params(request.params)?;
            let entries = engine
                .journal_entries(&params.run_id, 1, usize::MAX)
                .map_err(internal_error)?;
            hub.watch(connection_id, params.run_id.clone(), writer.clone());
            for entry in entries {
                write_frame(writer, &json!({"event": "entry", "data": entry}))
                    .map_err(internal_error)?;
            }
            Ok(json!({"watching": params.run_id}))
        }
        "worker.attach" => {
            let params: WorkerAttachParams = decode_params(request.params)?;
            if params.step_types.is_empty() {
                return Err(("bad_request", "worker must accept a step type".to_owned()));
            }
            hub.attach_worker(
                connection_id,
                params.worker_id.clone(),
                params.step_types,
                writer.clone(),
            );
            Ok(json!({"worker_id": params.worker_id}))
        }
        "step.heartbeat" => {
            let params: StepHeartbeatParams = decode_params(request.params)?;
            let deadline = hub
                .heartbeat(
                    connection_id,
                    &(params.run_id, params.step_id, params.attempt),
                    &params.lease_id,
                    now_ms(),
                )
                .map_err(protocol_conflict)?;
            Ok(json!({"lease_deadline_ms": deadline}))
        }
        "step.complete" => {
            let params: StepCompleteParams = decode_params(request.params)?;
            let key = (
                params.run_id.clone(),
                params.step_id.clone(),
                params.attempt,
            );
            let worker_id = hub
                .completion_worker(connection_id, &key)
                .map_err(protocol_conflict)?;
            let outcome = engine
                .complete_out_of_band(
                    &params.run_id,
                    &params.step_id,
                    OutOfBandCompletion {
                        attempt: params.attempt,
                        idempotency_key: params.idempotency_key,
                        completion_reason: params.completion_reason,
                        output: params.output,
                        budget: params.usage,
                        completed_by: worker_id,
                        end_pins: params.end_pins,
                        effects: Vec::new(),
                    },
                )
                .map_err(internal_error)?;
            hub.finish(&key);
            to_value(outcome)
        }
        "event.emit" => {
            let params: EventEmitParams = decode_params(request.params)?;
            let matched = engine
                .emit_event(&params.run_id, &params.event_key, params.payload)
                .map_err(internal_error)?;
            Ok(json!({"matched": matched}))
        }
        "stream.append" => {
            let params: StreamAppendParams = decode_params(request.params)?;
            let offset = engine
                .append_stream(
                    &params.run_id,
                    &params.stream,
                    "protocol-v0",
                    params.message,
                )
                .map_err(internal_error)?;
            Ok(json!({"offset": offset}))
        }
        "stream.read" => {
            let params: StreamReadParams = decode_params(request.params)?;
            let (messages, next_offset) = engine
                .read_stream(
                    &params.run_id,
                    &params.stream,
                    params.from_offset,
                    params.limit.unwrap_or(100).min(10_000),
                )
                .map_err(internal_error)?;
            Ok(json!({"messages": messages, "next_offset": next_offset}))
        }
        "journal.read" => {
            let params: JournalReadParams = decode_params(request.params)?;
            let entries = engine
                .journal_entries(
                    &params.run_id,
                    params.from_seq.unwrap_or(1),
                    params.limit.unwrap_or(100).min(10_000),
                )
                .map_err(internal_error)?;
            Ok(json!({"entries": entries}))
        }
        _ => Err((
            "unsupported_verb",
            format!("unknown journal protocol verb {}", request.verb),
        )),
    }
}

fn decode_params<T: DeserializeOwned>(params: Value) -> ProtocolResult<T> {
    serde_json::from_value(params).map_err(|error| ("bad_request", error.to_string()))
}

fn to_value(value: impl Serialize) -> ProtocolResult<Value> {
    serde_json::to_value(value).map_err(|error| internal_error(error.into()))
}

fn protocol_conflict(error: anyhow::Error) -> (&'static str, String) {
    ("lease_conflict", error.to_string())
}

fn internal_error(error: anyhow::Error) -> (&'static str, String) {
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

fn error_response(id: Value, code: &str, message: String) -> Response {
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

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(i64::MAX as u128) as i64
}

#[cfg(unix)]
pub fn resume_via_socket(data_dir: &Path, run_id: &str) -> Result<Option<crate::RunOutcome>> {
    use std::{
        io::{BufRead, BufReader, Write},
        os::unix::net::UnixStream,
    };

    let socket = data_dir.join("relayflowd.sock");
    if !socket.exists() {
        return Ok(None);
    }
    let mut connection = match UnixStream::connect(&socket) {
        Ok(connection) => connection,
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
            ) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error.into()),
    };
    serde_json::to_writer(
        &mut connection,
        &json!({"id": "cli-resume", "verb": "run.resume", "params": {"run_id": run_id}}),
    )?;
    connection.write_all(b"\n")?;
    connection.flush()?;
    for line in BufReader::new(connection).lines() {
        let response: Response = serde_json::from_str(&line?)?;
        if response.id != "cli-resume" {
            continue;
        }
        if !response.ok {
            let error = response.error.context("protocol error omitted detail")?;
            anyhow::bail!("{}: {}", error.code, error.message);
        }
        let outcome: crate::RunOutcome = serde_json::from_value(
            response
                .result
                .context("protocol response omitted result")?,
        )?;
        if outcome.status != crate::RunStatus::Parked {
            return Ok(Some(outcome));
        }
        let registry = relayflowd_journal::Registry::open(data_dir.join("relayflowd.sqlite3"))?;
        let initial_status = registry.lookup(run_id)?.map(|run| run.status);
        if matches!(initial_status.as_deref(), Some("completed" | "failed")) {
            return Ok(Some(Engine::new(data_dir).resume(run_id, None)?));
        }
        if initial_status.as_deref() != Some("waiting_worker") {
            return Ok(Some(outcome));
        }
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
        while std::time::Instant::now() < deadline {
            let status = registry.lookup(run_id)?.map(|run| run.status);
            if matches!(status.as_deref(), Some("completed" | "failed")) {
                return Ok(Some(Engine::new(data_dir).resume(run_id, None)?));
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        anyhow::bail!("timed out waiting for out-of-band completion of run {run_id}")
    }
    anyhow::bail!("relayflowd serve closed before run.resume replied")
}

#[cfg(not(unix))]
pub fn resume_via_socket(_data_dir: &Path, _run_id: &str) -> Result<Option<crate::RunOutcome>> {
    Ok(None)
}

#[cfg(test)]
mod tests {
    use std::{
        os::unix::net::UnixStream,
        sync::{Arc, Mutex},
    };

    use tempfile::tempdir;

    use super::*;

    #[test]
    fn hello_enforces_protocol_version() {
        let directory = tempdir().unwrap();
        let hub = Arc::new(ProtocolHub::default());
        let (writer, _peer) = UnixStream::pair().unwrap();
        let writer = Arc::new(Mutex::new(writer));
        let response = handle_line(
            directory.path(),
            &hub,
            1,
            &writer,
            r#"{"id":1,"verb":"hello","params":{"protocol":0,"client":"test"}}"#,
        );
        assert!(response.ok);
        let mismatch = handle_line(
            directory.path(),
            &hub,
            1,
            &writer,
            r#"{"id":2,"verb":"hello","params":{"protocol":1,"client":"test"}}"#,
        );
        assert!(!mismatch.ok);
    }

    #[test]
    fn run_start_fails_closed_on_an_unknown_verification_key() {
        let directory = tempdir().unwrap();
        let hub = Arc::new(ProtocolHub::default());
        let (writer, _peer) = UnixStream::pair().unwrap();
        let writer = Arc::new(Mutex::new(writer));
        let response = handle_line(
            directory.path(),
            &hub,
            1,
            &writer,
            r#"{"id":3,"verb":"run.start","params":{"spec":{"steps":[{"id":"x","type":"deterministic","command":"true","verification":{"output_contain":"x"}}]}}}"#,
        );
        assert!(!response.ok);
        assert_eq!(response.error.unwrap().code, "invalid_spec");
    }
}
