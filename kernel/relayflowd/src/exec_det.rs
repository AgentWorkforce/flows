use std::{
    io::Read,
    process::{Child, Command, Stdio},
    thread,
    time::Duration,
};

use relayflowd_core::{AttemptResult, Budget, CommandSpec, CompletionReason, StepKind, StepSpec};
use serde_json::{Value, json};
use wait_timeout::ChildExt;

const OUTPUT_TAIL_BYTES: usize = 64 * 1024;

pub fn execute(step: &StepSpec) -> AttemptResult {
    execute_with_memory(step, None)
}

pub fn execute_with_memory(
    step: &StepSpec,
    memory: Option<&relayflowd_core::MemoryInjectedPayload>,
) -> AttemptResult {
    execute_placed(step, memory, None)
}

pub(crate) fn execute_placed(
    step: &StepSpec,
    memory: Option<&relayflowd_core::MemoryInjectedPayload>,
    workspace: Option<&std::path::Path>,
) -> AttemptResult {
    execute_placed_with_input(step, memory, workspace, None)
}

pub(crate) fn execute_placed_with_input(
    step: &StepSpec,
    memory: Option<&relayflowd_core::MemoryInjectedPayload>,
    workspace: Option<&std::path::Path>,
    input: Option<&serde_json::Map<String, serde_json::Value>>,
) -> AttemptResult {
    if step.input.is_some() && input.is_none() {
        return worker_error("deterministic step input bindings were not resolved");
    }
    let StepKind::Deterministic {
        command,
        timeout_ms,
        lease_ms,
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
    if let Some(workspace) = workspace {
        process.current_dir(workspace);
    }
    process.env_remove("RELAYFLOW_MEMORY");
    if let Some(memory) = memory {
        process.env("RELAYFLOW_MEMORY", memory.pack.to_string());
    }
    process.env_remove("FLOWS_INPUT");
    if let Some(input) = input {
        // Transport JSON as data in the child environment. Never interpolate
        // upstream output into shell source, including quotes or metacharacters.
        process.env("FLOWS_INPUT", Value::Object(input.clone()).to_string());
    }
    process.stdout(Stdio::piped()).stderr(Stdio::piped());
    // Run the command in its own process group so a timeout can kill every
    // descendant. Killing only the shell leaves children that inherited the
    // stdout/stderr pipes alive, and the reader-thread joins below would then
    // block far past `timeout_ms`.
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        process.process_group(0);
    }
    let mut child = match process.spawn() {
        Ok(child) => child,
        Err(error) => return worker_error(&format!("failed to spawn command: {error}")),
    };

    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let stdout_reader = thread::spawn(move || read_all(stdout));
    let stderr_reader = thread::spawn(move || read_all(stderr));
    let timeout = Duration::from_millis(match (lease_ms, timeout_ms) {
        (Some(lease), Some(command)) => (*lease).min(*command),
        (Some(lease), None) => *lease,
        (None, command) => command.unwrap_or(30_000),
    });
    let (status, timed_out) = match child.wait_timeout(timeout) {
        Ok(Some(status)) => (Some(status), false),
        Ok(None) => {
            kill_process_group(&mut child);
            (child.wait().ok(), true)
        }
        Err(error) => {
            kill_process_group(&mut child);
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
    // Failed completions deliberately null their reusable output. Preserve
    // command evidence in the existing diagnostic field before that happens.
    let trajectory_tail = (output["exit_code"] != 0)
        .then(|| json!({ "exit_code": output["exit_code"], "stderr_tail": output["stderr_tail"] }));
    AttemptResult {
        human_intervention: false,
        output,
        budget: Budget::default(),
        completed_by: "kernel".to_owned(),
        end_pins: None,
        effects: vec![],
        trajectory_tail,
        failure_reason: timed_out.then_some(CompletionReason::Timeout),
        failure_detail: timed_out
            .then(|| format!("step exceeded its {} ms timeout", timeout.as_millis())),
    }
}

/// Kill the command's whole process group (the child was spawned as its own
/// group leader, so the group id is the child's pid), then the child itself as
/// a fallback. SIGKILL to `-pid` reaches every descendant still in the group,
/// closing the inherited stdout/stderr pipes so the reader joins return.
fn kill_process_group(child: &mut Child) {
    #[cfg(unix)]
    {
        let pid = child.id() as i32;
        // SAFETY: plain libc kill(2) on a negative pid — no memory at play.
        unsafe {
            libc::kill(-pid, libc::SIGKILL);
        }
    }
    let _ = child.kill();
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
        human_intervention: false,
        output: json!({"error": detail}),
        budget: Budget::default(),
        completed_by: "kernel".to_owned(),
        end_pins: None,
        effects: vec![],
        trajectory_tail: None,
        failure_reason: Some(CompletionReason::WorkerError),
        failure_detail: Some(detail.to_owned()),
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
        assert_eq!(result.trajectory_tail, None);
    }

    #[test]
    fn failed_command_evidence_survives_completion() {
        use relayflowd_core::machine::{Action, completion_actions};

        let step: StepSpec = serde_json::from_value(json!({
            "id": "fail-command", "type": "deterministic",
            "command": "printf 'shakedown intentional failure' >&2; exit 7"
        }))
        .unwrap();
        let actions = completion_actions("run", &step, 1, 0, execute(&step), 0);
        let Action::Append(completed) = &actions[0] else {
            panic!("expected completion")
        };
        // Post-#292: structured output survives on failed deterministic completions
        // so the CLI diagnostic (#276 / merged as #366) can render exit code + stderr
        // directly, without falling back to trajectory_tail.
        assert_eq!(completed.payload["output"]["exit_code"], 7);
        assert_eq!(
            completed.payload["output"]["stderr_tail"],
            "shakedown intentional failure"
        );
        assert_eq!(completed.payload["trajectory_tail"]["exit_code"], 7);
        assert_eq!(
            completed.payload["trajectory_tail"]["stderr_tail"],
            "shakedown intentional failure"
        );
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

    #[test]
    fn lease_override_bounds_execution_and_preserves_command_timeout() {
        for (lease, command_timeout) in [(5, None), (1000, Some(5))] {
            let mut value = json!({
                "id": "slow", "type": "deterministic", "command": "sleep 1", "lease_ms": lease
            });
            if let Some(ms) = command_timeout {
                value["timeout_ms"] = json!(ms);
            }
            let step: StepSpec = serde_json::from_value(value).unwrap();
            let started = std::time::Instant::now();
            let result = execute(&step);
            assert_eq!(result.failure_reason, Some(CompletionReason::Timeout));
            assert!(started.elapsed() < Duration::from_millis(900));
        }
    }

    #[test]
    fn timeout_kills_the_whole_process_group() {
        // The backgrounded sleep inherits the stdout/stderr pipes. If a
        // timeout killed only the shell, the reader joins would block until
        // the sleep exits (~30s). Killing the process group must bound the
        // whole call near timeout_ms.
        let step: StepSpec = serde_json::from_value(json!({
            "id": "orphan", "type": "deterministic",
            "command": "sleep 30 & echo started; wait",
            "timeout_ms": 250
        }))
        .unwrap();
        let started = std::time::Instant::now();
        let result = execute(&step);
        let elapsed = started.elapsed();
        assert_eq!(result.failure_reason, Some(CompletionReason::Timeout));
        assert!(
            elapsed < Duration::from_secs(3),
            "timeout must not wait on orphaned descendants (took {elapsed:?})"
        );
        assert!(
            result.output["stdout_tail"]
                .as_str()
                .unwrap()
                .contains("started"),
            "output produced before the timeout is still captured"
        );
    }
}
