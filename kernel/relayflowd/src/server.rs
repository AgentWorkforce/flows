use std::path::Path;

use anyhow::{Context, Result};
use relayflowd_core::{CompletionReason, PROTOCOL_VERSION, RunSpec, StepType};
use serde::{Serialize, de::DeserializeOwned};
use serde_json::{Value, json};

use crate::{Engine, OutOfBandCompletion};

#[cfg(unix)]
mod reconcile;
#[cfg(unix)]
mod session;
#[cfg(unix)]
use session::{ProtocolHub, SharedWriter, write_frame};

/// Cap on the worker-supplied `inspect` trajectory tail. It is evidence for a
/// human and for the next attempt's prompt, not a transcript store.
const TRAJECTORY_TAIL_MAX_BYTES: usize = 16 * 1024;
mod client;
pub use client::resume_via_socket;

mod wire;
use wire::*;

#[cfg(all(test, unix))]
mod tests;

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
    reconcile::spawn_reconciler(data_dir.to_path_buf(), hub.clone());
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
            abandon_connection(&data_dir, &hub, connection_id);
            Ok::<_, anyhow::Error>(())
        });
    }
    Ok(())
}

/// Explain every lease a closed connection held. Fail closed: a journal
/// append that fails is logged AND the abandonment is retained for the
/// reconciler to retry — the journal must eventually record the completion,
/// never silently lose an active attempt.
#[cfg(unix)]
fn abandon_connection(data_dir: &Path, hub: &std::sync::Arc<ProtocolHub>, connection_id: u64) {
    let dispatcher: std::sync::Arc<dyn crate::worker::StepDispatcher> = hub.clone();
    let observer: std::sync::Arc<dyn crate::worker::JournalObserver> = hub.clone();
    let engine = Engine::with_runtime(data_dir, dispatcher, observer);
    for lease in hub.detach(connection_id) {
        let lock = hub.run_lock(&lease.run_id);
        let _guard = lock.lock().expect("run lock");
        if let Err(error) = engine.abandon_out_of_band(
            &lease.run_id,
            &lease.step_id,
            lease.attempt,
            CompletionReason::Crashed,
        ) {
            eprintln!(
                "relayflowd: error: failed to journal crashed completion for run {} step {} attempt {}: {error:#}; retained for reconciler retry",
                lease.run_id, lease.step_id, lease.attempt
            );
            hub.queue_abandonment(lease, CompletionReason::Crashed);
        }
    }
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
            // Per-run serialization: the load-state -> next_actions -> append
            // sequence must be atomic, or two concurrent resumes both see a
            // step Runnable and double-dispatch the same attempt.
            let lock = hub.run_lock(&params.run_id);
            let _guard = lock.lock().expect("run lock");
            // Live resume: attempts with a valid, heartbeating lease on this
            // hub stay running; only genuinely dead attempts are recovered.
            to_value(
                engine
                    .resume_live(&params.run_id, hub.as_ref())
                    .map_err(internal_error)?,
            )
        }
        "run.get" => {
            let params: RunIdParams = decode_params(request.params)?;
            to_value(engine.snapshot(&params.run_id).map_err(internal_error)?)
        }
        "run.watch" => {
            let params: RunIdParams = decode_params(request.params)?;
            watch_with_replay(&engine, hub, connection_id, &params.run_id, writer, || ())
        }
        "worker.attach" => {
            let params: WorkerAttachParams = decode_params(request.params)?;
            if params.step_types.is_empty() {
                return Err(("bad_request", "worker must accept a step type".to_owned()));
            }
            // Appendix A rule 2: an agent attempt is journaled with the opaque
            // revisions the worker reports. A worker that accepts agent steps
            // and reports no surface at all can never supply them, and that is
            // provable here — refusing the attach keeps the failure out of the
            // middle of a run that has already started.
            if params.step_types.contains(&StepType::Agent)
                && params.pins.workspace.is_empty()
                && params.pins.streams.is_empty()
            {
                return Err((
                    "bad_request",
                    "an agent worker must attach with the pins of the surfaces it holds".to_owned(),
                ));
            }
            hub.attach_worker(
                connection_id,
                params.worker_id.clone(),
                params.step_types,
                params.pins,
                writer.clone(),
            );
            Ok(json!({"worker_id": params.worker_id}))
        }
        "step.heartbeat" => {
            let params: StepHeartbeatParams = decode_params(request.params)?;
            let deadline = hub
                .heartbeat(
                    connection_id,
                    &(params.run_id.clone(), params.step_id, params.attempt),
                    &params.lease_id,
                    now_ms(),
                )
                .map_err(protocol_conflict)?;
            // Durable renewal: persist the extended deadline so the lease the
            // reconciler sweeps against is recorded, not memory-only. A failed
            // write fails the heartbeat — the worker must not believe its
            // lease was extended when nothing durable says so.
            engine
                .renew_lease(&params.run_id, deadline)
                .map_err(internal_error)?;
            Ok(json!({"lease_deadline_ms": deadline}))
        }
        "step.complete" => {
            let params: StepCompleteParams = decode_params(request.params)?;
            // `trajectory_tail` is journaled evidence, re-decoded on every fold.
            // Bound it here, at the boundary that admits it, so "bounded" is a
            // fact rather than a claim in a doc comment.
            if let Some(tail) = &params.trajectory_tail
                && serde_json::to_vec(tail).map_or(0, |bytes| bytes.len())
                    > TRAJECTORY_TAIL_MAX_BYTES
            {
                return Err((
                    "bad_request",
                    format!("trajectory_tail exceeds {TRAJECTORY_TAIL_MAX_BYTES} bytes"),
                ));
            }
            let key = (
                params.run_id.clone(),
                params.step_id.clone(),
                params.attempt,
            );
            let lock = hub.run_lock(&params.run_id);
            let _guard = lock.lock().expect("run lock");
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
                        started_pins: params.started_pins,
                        end_pins: params.end_pins,
                        effects: params.effects,
                        trajectory_tail: params.trajectory_tail,
                    },
                )
                .map_err(internal_error)?;
            hub.finish(&key);
            to_value(outcome)
        }
        "effect.record" => {
            let params: EffectRecordParams = decode_params(request.params)?;
            let key = (
                params.run_id.clone(),
                params.step_id.clone(),
                params.attempt,
            );
            let lock = hub.run_lock(&params.run_id);
            let _guard = lock.lock().expect("run lock");
            let worker_id = hub
                .completion_worker(connection_id, &key)
                .map_err(protocol_conflict)?;
            let deduped = engine
                .record_effect(
                    &params.run_id,
                    &params.step_id,
                    params.attempt,
                    &params.idempotency_key,
                    &params.surface_path,
                    &params.revision_before,
                    &params.revision_after,
                    &worker_id,
                )
                .map_err(internal_error)?;
            Ok(json!({"deduped": deduped}))
        }
        "event.emit" => {
            let params: EventEmitParams = decode_params(request.params)?;
            let lock = hub.run_lock(&params.run_id);
            let _guard = lock.lock().expect("run lock");
            let matched = engine
                .emit_event(&params.run_id, &params.event_key, params.payload)
                .map_err(internal_error)?;
            Ok(json!({"matched": matched}))
        }
        "stream.append" => {
            let params: StreamAppendParams = decode_params(request.params)?;
            let lock = hub.run_lock(&params.run_id);
            let _guard = lock.lock().expect("run lock");
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

/// Register the watcher BEFORE replaying, then replay and hand the hub the
/// sequence cursor the replay covered. Entries appended concurrently are
/// buffered by the hub and flushed deduped against that cursor, so nothing
/// appended between snapshot and registration can be missed — that ordering
/// gap no longer exists. `after_register` is a test seam pinning the race
/// window between registration and the snapshot read.
#[cfg(unix)]
fn watch_with_replay(
    engine: &Engine,
    hub: &std::sync::Arc<ProtocolHub>,
    connection_id: u64,
    run_id: &str,
    writer: &SharedWriter,
    after_register: impl FnOnce(),
) -> ProtocolResult<Value> {
    hub.watch(connection_id, run_id.to_owned(), writer.clone());
    after_register();
    let replay = (|| -> Result<()> {
        let entries = engine.journal_entries(run_id, 1, usize::MAX)?;
        let replayed_through_seq = entries.last().map(|entry| entry.seq).unwrap_or(0);
        for entry in entries {
            write_frame(writer, &json!({"event": "entry", "data": entry}))?;
        }
        hub.watch_ready(connection_id, run_id, replayed_through_seq);
        Ok(())
    })();
    if let Err(error) = replay {
        // Fail closed: never leave a half-registered watcher buffering forever.
        hub.unwatch(connection_id, run_id);
        return Err(internal_error(error));
    }
    Ok(json!({"watching": run_id}))
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
