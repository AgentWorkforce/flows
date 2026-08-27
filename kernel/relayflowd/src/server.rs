use std::{
    io::{BufRead, BufReader, Write},
    path::Path,
};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::Engine;

#[derive(Debug, Deserialize)]
struct Request {
    id: Value,
    verb: String,
    #[serde(default)]
    params: Value,
}

#[derive(Debug, Serialize)]
struct Response {
    id: Value,
    ok: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    result: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<ProtocolError>,
}

#[derive(Debug, Serialize)]
struct ProtocolError {
    code: String,
    message: String,
}

#[cfg(unix)]
pub fn serve(data_dir: &Path) -> Result<()> {
    use std::os::unix::net::UnixListener;

    std::fs::create_dir_all(data_dir)?;
    let socket_path = data_dir.join("relayflowd.sock");
    if socket_path.exists() {
        std::fs::remove_file(&socket_path)
            .with_context(|| format!("remove stale socket {}", socket_path.display()))?;
    }
    let listener = UnixListener::bind(&socket_path)
        .with_context(|| format!("bind socket {}", socket_path.display()))?;
    for connection in listener.incoming() {
        let mut connection = connection?;
        let reader = BufReader::new(connection.try_clone()?);
        for line in reader.lines() {
            let response = match line {
                Ok(line) => handle_line(data_dir, &line),
                Err(error) => error_response(Value::Null, "bad_request", error.to_string()),
            };
            serde_json::to_writer(&mut connection, &response)?;
            connection.write_all(b"\n")?;
            connection.flush()?;
        }
    }
    Ok(())
}

#[cfg(not(unix))]
pub fn serve(_data_dir: &Path) -> Result<()> {
    anyhow::bail!("journal protocol v0 requires Unix domain sockets")
}

fn handle_line(data_dir: &Path, line: &str) -> Response {
    let request: Request = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => return error_response(Value::Null, "bad_request", error.to_string()),
    };
    let id = request.id.clone();
    match handle_request(data_dir, request) {
        Ok(result) => Response {
            id,
            ok: true,
            result: Some(result),
            error: None,
        },
        Err((code, message)) => error_response(id, code, message),
    }
}

fn handle_request(data_dir: &Path, request: Request) -> Result<Value, (&'static str, String)> {
    let engine = Engine::new(data_dir);
    match request.verb.as_str() {
        "hello" => {
            let protocol = request.params["protocol"].as_u64();
            if protocol != Some(u64::from(relayflowd_core::PROTOCOL_VERSION)) {
                return Err((
                    "protocol_mismatch",
                    "relayflowd supports protocol 0".to_owned(),
                ));
            }
            Ok(json!({"protocol": relayflowd_core::PROTOCOL_VERSION, "server": "relayflowd"}))
        }
        "run.start" => {
            // Fail closed at the protocol boundary: a spec with an unknown
            // field (e.g. a misspelled verification key) is rejected, never
            // accepted with the gate silently dropped.
            let spec = relayflowd_core::RunSpec::parse(&request.params["spec"])
                .map_err(|error| ("invalid_spec", error.to_string()))?;
            let outcome = engine
                .start(spec, "protocol-v0", None)
                .map_err(internal_error)?;
            serde_json::to_value(outcome).map_err(|error| internal_error(error.into()))
        }
        "run.resume" => {
            let run_id = required_string(&request.params, "run_id")?;
            let outcome = engine.resume(run_id, None).map_err(internal_error)?;
            serde_json::to_value(outcome).map_err(|error| internal_error(error.into()))
        }
        "run.get" => {
            let run_id = required_string(&request.params, "run_id")?;
            let snapshot = engine.snapshot(run_id).map_err(internal_error)?;
            serde_json::to_value(snapshot).map_err(|error| internal_error(error.into()))
        }
        "journal.read" => {
            let run_id = required_string(&request.params, "run_id")?;
            let from_seq = request.params["from_seq"].as_i64().unwrap_or(1);
            let limit = request.params["limit"].as_u64().unwrap_or(100) as usize;
            let entries = engine
                .journal_entries(run_id, from_seq, limit)
                .map_err(internal_error)?;
            Ok(json!({"entries": entries}))
        }
        _ => Err((
            "unsupported_verb",
            format!(
                "{} is not available in the deterministic gate-1 rung",
                request.verb
            ),
        )),
    }
}

fn required_string<'a>(params: &'a Value, key: &str) -> Result<&'a str, (&'static str, String)> {
    params[key]
        .as_str()
        .ok_or_else(|| ("bad_request", format!("missing string parameter {key}")))
}

fn internal_error(error: anyhow::Error) -> (&'static str, String) {
    // Classify by the typed error in the cause chain, not by message
    // substrings: any journal-layer failure is `journal_write_failed`.
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

#[cfg(test)]
mod tests {
    use tempfile::tempdir;

    use super::*;

    #[test]
    fn hello_enforces_protocol_version() {
        let directory = tempdir().unwrap();
        let response = handle_line(
            directory.path(),
            r#"{"id":1,"verb":"hello","params":{"protocol":0,"client":"test"}}"#,
        );
        assert!(response.ok);
        let mismatch = handle_line(
            directory.path(),
            r#"{"id":2,"verb":"hello","params":{"protocol":1,"client":"test"}}"#,
        );
        assert!(!mismatch.ok);
    }

    #[test]
    fn run_start_fails_closed_on_an_unknown_verification_key() {
        // A misspelled gate key must be rejected at the boundary, never
        // accepted with the gate silently dropped (AGENTS.md rule 4).
        let directory = tempdir().unwrap();
        let response = handle_line(
            directory.path(),
            r#"{"id":3,"verb":"run.start","params":{"spec":{"steps":[{"id":"x","type":"deterministic","command":"true","verification":{"output_contain":"x"}}]}}}"#,
        );
        assert!(!response.ok);
        assert_eq!(response.error.unwrap().code, "invalid_spec");
    }
}
