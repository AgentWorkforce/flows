use std::{
    collections::BTreeMap,
    fs,
    os::unix::process::CommandExt,
    path::{Path, PathBuf},
    process::{Child, Command},
    time::{Duration, Instant},
};

use relayflowd::{RunOutcome, RunStatus};
use relayflowd_core::{
    Budget, CompletionReason, EntryType, Journal, JournalEntry, RunCompletedPayload,
    StepCompletedPayload,
};
use relayflowd_journal::SqliteJournal;
use serde_json::json;
use tempfile::{TempDir, tempdir};

const STEP_IDS: [&str; 3] = ["first", "second", "third"];

pub struct Fixture {
    _directory: TempDir,
    pub data_dir: PathBuf,
    pub marker: PathBuf,
    pub attempts: PathBuf,
    pub gate: PathBuf,
    pub step_pid: PathBuf,
    pub spec_path: PathBuf,
}

impl Fixture {
    pub fn hello(name: &str) -> Self {
        Self::new(name, false)
    }

    pub fn blocking(name: &str) -> Self {
        Self::new(name, true)
    }

    pub fn socket(&self) -> PathBuf {
        relayflowd::socket_path::derive_socket_path(&self.data_dir)
            .expect("derive socket path")
    }

    fn new(name: &str, blocking_second: bool) -> Self {
        let directory = tempdir().unwrap();
        let data_dir = directory.path().join("data");
        let marker = directory.path().join("effects.txt");
        let attempts = directory.path().join("attempts.txt");
        let gate = directory.path().join("gate");
        let step_pid = directory.path().join("step.pid");
        let spec_path = directory.path().join("run.json");
        let second = if blocking_second {
            format!(
                "printf 'started\\n' >> '{attempts}'; printf '%s' \"$$\" > '{step_pid}'; while [ ! -f '{gate}' ]; do sleep 0.02; done; printf 'second\\n' >> '{marker}'",
                attempts = attempts.to_string_lossy(),
                step_pid = step_pid.to_string_lossy(),
                gate = gate.to_string_lossy(),
                marker = marker.to_string_lossy(),
            )
        } else {
            format!("printf 'second\\n' >> '{}'", marker.to_string_lossy())
        };
        let spec = json!({
            "name": format!("crash-{name}"),
            "steps": [
                {
                    "id": "first",
                    "type": "deterministic",
                    "command": ["/bin/sh", "-c", format!("printf 'first\\n' >> '{}'", marker.to_string_lossy())]
                },
                {
                    "id": "second",
                    "type": "deterministic",
                    "depends_on": ["first"],
                    "command": ["/bin/sh", "-c", second]
                },
                {
                    "id": "third",
                    "type": "deterministic",
                    "depends_on": ["second"],
                    "command": ["/bin/sh", "-c", format!("printf 'third\\n' >> '{}'", marker.to_string_lossy())]
                }
            ]
        });
        fs::write(&spec_path, serde_json::to_vec(&spec).unwrap()).unwrap();
        Self {
            _directory: directory,
            data_dir,
            marker,
            attempts,
            gate,
            step_pid,
            spec_path,
        }
    }
}

pub fn spawn_run(
    fixture: &Fixture,
    pause_before_step: Option<&str>,
    pause_before_completion: bool,
) -> Child {
    let mut command = Command::new(env!("CARGO_BIN_EXE_relayflowd"));
    command
        .args(["--data-dir", fixture.data_dir.to_str().unwrap(), "run"])
        .arg(&fixture.spec_path);
    if let Some(step) = pause_before_step {
        command.args(["--pause-before-step", step]);
    }
    if pause_before_completion {
        command.arg("--pause-before-completion");
    }
    command.process_group(0).spawn().unwrap()
}

pub fn resume_cli(data_dir: &Path) -> RunOutcome {
    let run_id = only_run_id(data_dir);
    let output = Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .args(["--data-dir", data_dir.to_str().unwrap(), "resume", &run_id])
        .output()
        .unwrap();
    assert!(output.status.success(), "resume failed: {output:?}");
    let outcome: RunOutcome = serde_json::from_slice(&output.stdout).unwrap();
    assert_eq!(outcome.status, RunStatus::Completed);
    outcome
}

pub fn wait_until(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        std::thread::sleep(Duration::from_millis(20));
    }
}

pub fn kill_process_group(child: &mut Child) {
    kill_group(child.id());
    let status = child.wait().unwrap();
    assert!(
        !status.success(),
        "SIGKILLed process unexpectedly succeeded"
    );
}

pub fn kill_group(pid: u32) {
    // SAFETY: kill(2) with a negative process-group id does not access memory.
    let result = unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
    assert_eq!(result, 0, "failed to SIGKILL process group {pid}");
}

pub fn read_pid(path: &Path) -> u32 {
    fs::read_to_string(path).unwrap().trim().parse().unwrap()
}

pub fn journal_entries(data_dir: &Path) -> Option<Vec<JournalEntry>> {
    let run_id = only_run_id_if_present(data_dir)?;
    let journal =
        SqliteJournal::open(data_dir.join("runs").join(format!("{run_id}.sqlite3"))).ok()?;
    let segment = journal.current_segment().ok()?;
    journal.scan_segment(segment).ok()
}

/// Everything known about a stalled resume, as one panic message.
///
/// When a dispatch never arrives (#174) the useful state is all on the daemon
/// side and none of it is captured today: `wait_with_output` is never reached,
/// so the child's output is discarded when the test unwinds, and the journal is
/// never read. Four occurrences produced four test names and nothing else.
///
/// The child may be STALLED or may have ALREADY EXITED -- #174 turned out to be
/// the second, a resume that died instantly with `run_not_found` while the test
/// waited on it. Both look identical from here, which is the point: this
/// attempts termination and reaps it either way (both results are discarded
/// because "already gone" is a normal outcome, not an error), then reports its
/// output alongside the run's journal.
///
/// The journal listing covers the CURRENT segment, which is what
/// `journal_entries` scans. These crash tests do not compact, so that is every
/// entry they produce; it would not be under compaction.
pub fn describe_stalled_resume(data_dir: &Path, resume: &mut Child) -> String {
    let mut report = String::new();

    // Kill before read. The child is not going to finish on its own.
    let _ = resume.kill();
    let _ = resume.wait();

    let mut stdout = String::new();
    let mut stderr = String::new();
    if let Some(mut handle) = resume.stdout.take() {
        let _ = std::io::Read::read_to_string(&mut handle, &mut stdout);
    }
    if let Some(mut handle) = resume.stderr.take() {
        let _ = std::io::Read::read_to_string(&mut handle, &mut stderr);
    }
    report.push_str(&format!(
        "\n--- resume child ---\nstdout ({} bytes):\n{stdout}\nstderr ({} bytes):\n{stderr}\n",
        stdout.len(),
        stderr.len()
    ));

    // The journal says how far the run actually got, which is the question a
    // missing dispatch raises: did the daemon resume and stall, or never resume?
    match journal_entries(data_dir) {
        None => report.push_str("--- journal --- absent (no run directory)\n"),
        Some(entries) => {
            report.push_str(&format!("--- journal ({} entries) ---\n", entries.len()));
            for entry in &entries {
                report.push_str(&format!(
                    "  seq={} type={:?} step={:?}\n",
                    entry.seq, entry.entry_type, entry.step_id
                ));
            }
        }
    }
    report
}

pub fn completed_step_count(entries: &[JournalEntry]) -> usize {
    entries
        .iter()
        .filter(|entry| {
            if entry.entry_type != EntryType::StepCompleted {
                return false;
            }
            serde_json::from_value::<StepCompletedPayload>(entry.payload.clone())
                .is_ok_and(|payload| payload.completion_reason == CompletionReason::Success)
        })
        .count()
}

pub fn assert_exact_journal(
    data_dir: &Path,
    expected_starts: &[usize; 3],
    expected_dead: Option<(&str, u32)>,
) {
    let entries = journal_entries(data_dir).unwrap();
    let mut starts = BTreeMap::new();
    let mut successes = BTreeMap::new();
    let mut recorded = Budget::default();
    let mut dead = Vec::new();
    for entry in &entries {
        if entry.entry_type == EntryType::StepAttemptStarted {
            *starts.entry(entry.step_id.as_deref().unwrap()).or_insert(0) += 1;
        }
        if entry.entry_type != EntryType::StepCompleted {
            continue;
        }
        let payload: StepCompletedPayload = serde_json::from_value(entry.payload.clone()).unwrap();
        if payload.completion_reason == CompletionReason::Success {
            *successes
                .entry(entry.step_id.as_deref().unwrap())
                .or_insert(0) += 1;
            recorded.tokens_in += payload.budget.tokens_in;
            recorded.tokens_out += payload.budget.tokens_out;
            assert_eq!(payload.budget.dollars, "0");
        } else if matches!(
            payload.completion_reason,
            CompletionReason::Crashed | CompletionReason::LeaseExpired
        ) {
            dead.push((entry.step_id.as_deref().unwrap(), entry.attempt.unwrap()));
            assert_eq!(payload.budget, Budget::default());
        }
    }
    for (index, step_id) in STEP_IDS.into_iter().enumerate() {
        assert_eq!(
            starts.get(step_id),
            Some(&expected_starts[index]),
            "{step_id} starts"
        );
        assert_eq!(successes.get(step_id), Some(&1), "{step_id} successes");
    }
    assert_eq!(dead.as_slice(), expected_dead.as_slice());

    let completed: Vec<RunCompletedPayload> = entries
        .iter()
        .filter(|entry| entry.entry_type == EntryType::RunCompleted)
        .map(|entry| serde_json::from_value(entry.payload.clone()).unwrap())
        .collect();
    assert_eq!(completed.len(), 1, "run completion must be journaled once");
    assert_eq!(completed[0].budget_total, recorded);
    assert_eq!(
        recorded,
        Budget::default(),
        "deterministic steps spend zero tokens"
    );
}

pub fn only_run_id(data_dir: &Path) -> String {
    only_run_id_if_present(data_dir).expect("expected exactly one run journal")
}

fn only_run_id_if_present(data_dir: &Path) -> Option<String> {
    let mut ids: Vec<String> = fs::read_dir(data_dir.join("runs"))
        .ok()?
        .filter_map(|entry| {
            let name = entry.ok()?.file_name().into_string().ok()?;
            name.strip_suffix(".sqlite3").map(str::to_owned)
        })
        .collect();
    (ids.len() == 1).then(|| ids.pop().unwrap())
}
