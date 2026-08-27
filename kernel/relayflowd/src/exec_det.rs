use std::{
    io::Read,
    process::{Command, Stdio},
    thread,
    time::Duration,
};

use relayflowd_core::{AttemptResult, Budget, CommandSpec, CompletionReason, StepKind, StepSpec};
use serde_json::json;
use wait_timeout::ChildExt;

const OUTPUT_TAIL_BYTES: usize = 64 * 1024;

pub fn execute(step: &StepSpec) -> AttemptResult {
    let StepKind::Deterministic {
        command,
        timeout_ms,
    } = &step.kind
    else {
        return worker_error("deterministic executor received a non-deterministic step");
    };
    let mut process = match command {
        CommandSpec::Shell(script) => {
            let mut command = Command::new("/bin/sh");
            command.args(["-c", script]);
            command
        }
        CommandSpec::Argv(arguments) => {
            let Some((program, arguments)) = arguments.split_first() else {
                return worker_error("deterministic command argv cannot be empty");
            };
            let mut command = Command::new(program);
            command.args(arguments);
            command
        }
    };
    process.stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => return worker_error(&format!("failed to spawn command: {error}")),
    };

    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let stdout_reader = thread::spawn(move || read_all(stdout));
    let stderr_reader = thread::spawn(move || read_all(stderr));
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(30_000));
    let (status, timed_out) = match child.wait_timeout(timeout) {
        Ok(Some(status)) => (Some(status), false),
        Ok(None) => {
            let _ = child.kill();
            (child.wait().ok(), true)
        }
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return worker_error(&format!("failed while waiting for command: {error}"));
        }
    };
    let stdout = stdout_reader.join().unwrap_or_default();
    let stderr = stderr_reader.join().unwrap_or_default();
    let output = json!({
        "exit_code": status.and_then(|status| status.code()).unwrap_or(-1),
        "stdout_tail": tail(&stdout),
        "stderr_tail": tail(&stderr),
    });
    AttemptResult {
        output,
        budget: Budget::default(),
        completed_by: "kernel".to_owned(),
        end_pins: None,
        effects: vec![],
        failure_reason: timed_out.then_some(CompletionReason::Timeout),
    }
}

fn read_all(mut reader: impl Read) -> Vec<u8> {
    let mut bytes = Vec::new();
    let _ = reader.read_to_end(&mut bytes);
    bytes
}

fn tail(bytes: &[u8]) -> String {
    let start = bytes.len().saturating_sub(OUTPUT_TAIL_BYTES);
    String::from_utf8_lossy(&bytes[start..]).into_owned()
}

fn worker_error(detail: &str) -> AttemptResult {
    AttemptResult {
        output: json!({"error": detail}),
        budget: Budget::default(),
        completed_by: "kernel".to_owned(),
        end_pins: None,
        effects: vec![],
        failure_reason: Some(CompletionReason::WorkerError),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn captures_deterministic_output() {
        let step: StepSpec = serde_json::from_value(json!({
            "id": "hello", "type": "deterministic", "command": ["/bin/sh", "-c", "printf hello"]
        }))
        .unwrap();
        let result = execute(&step);
        assert_eq!(result.output["exit_code"], 0);
        assert_eq!(result.output["stdout_tail"], "hello");
        assert_eq!(result.failure_reason, None);
    }

    #[test]
    fn timeout_has_an_explicit_completion_reason() {
        let step: StepSpec = serde_json::from_value(json!({
            "id": "slow", "type": "deterministic", "command": "sleep 1", "timeout_ms": 5
        }))
        .unwrap();
        let result = execute(&step);
        assert_eq!(result.failure_reason, Some(CompletionReason::Timeout));
    }
}
