//! Harness for the trusted det-step credential design fixture.
//!
//! Everything a test observes is captured as bytes, so the "no value leaks"
//! assertions are made on what actually crossed each boundary:
//! - bytes the test client SENT to the daemon (`Fixture::sent`) and bytes the
//!   daemon SENT BACK (`Fixture::received`), kept apart: a nonconforming raw
//!   client can always put its own values on the wire, and the kernel cannot
//!   erase incoming bytes -- it can only refuse or strip them;
//! - the daemon's own stdout/stderr (`Daemon::output`);
//! - every file under the data dir (journal, registry, checkpoints).
//!
//! The proposal's interface (frame, pins, challenge-response, builders) lives
//! in contract.rs; this file is process, wire and evidence plumbing.

use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    os::unix::{net::UnixStream, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, ExitStatus, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

use super::contract::Binding;

pub const PROPOSAL: &str = "docs/proposals/trusted-det-step-credentials.md";

pub type Capture = Arc<Mutex<Vec<u8>>>;

pub struct Fixture {
    _directory: TempDir,
    pub data_dir: PathBuf,
    /// Outside the data dir: env dumps, gates, credential source files.
    pub scratch: PathBuf,
    pub sent: Capture,
    pub received: Capture,
}

impl Fixture {
    pub fn new() -> Self {
        let directory = tempdir().unwrap();
        let data_dir = directory.path().join("data");
        let scratch = directory.path().join("scratch");
        fs::create_dir_all(&scratch).unwrap();
        Self {
            _directory: directory,
            data_dir,
            scratch,
            sent: Capture::default(),
            received: Capture::default(),
        }
    }

    pub fn socket(&self) -> PathBuf {
        relayflowd::socket_path::derive_socket_path(&self.data_dir).unwrap()
    }

    pub fn connect(&self) -> Wire {
        Wire::connect(&self.socket(), self.sent.clone(), self.received.clone())
    }
}

pub struct Daemon {
    child: Option<Child>,
    output: Capture,
}

/// A daemon that refused to serve: its exit status and everything it printed.
pub struct Refused {
    pub status: ExitStatus,
    pub output: String,
}

impl Daemon {
    /// Start `relayflowd serve` as a trusted host would: a clean spawn env,
    /// `--det-frame-stdin` in argv, and one stdin frame (contract.rs).
    ///
    /// On a kernel without the feature this panics with the design-fixture
    /// reason: every ignored test then fails at the SAME point, which shows
    /// the future interface is ABSENT -- not that each test is a distinct
    /// security regression on main.
    pub fn start(fixture: &Fixture, binding: Option<&Binding>, env: &[(&str, &str)]) -> Self {
        match Self::try_start(fixture, binding, env) {
            Ok(daemon) => daemon,
            Err(refused) => panic!(
                "DESIGN FIXTURE: relayflowd exited ({}) instead of serving with the trusted \
                 det-step credential binding. The interface in {PROPOSAL} is absent from this \
                 kernel. Daemon said: {}",
                refused.status, refused.output
            ),
        }
    }

    pub fn try_start(
        fixture: &Fixture,
        binding: Option<&Binding>,
        env: &[(&str, &str)],
    ) -> std::result::Result<Self, Refused> {
        let mut command = Command::new(env!("CARGO_BIN_EXE_relayflowd"));
        command
            .args(["--data-dir", fixture.data_dir.to_str().unwrap(), "serve"])
            .args(binding.map(Binding::args).unwrap_or_default())
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", &fixture.scratch)
            // The socket path derives from these (socket_path.rs runtime_dir);
            // Cloud's base env keeps them too.
            .envs(
                ["XDG_RUNTIME_DIR", "TMPDIR"]
                    .into_iter()
                    .filter_map(|name| std::env::var_os(name).map(|value| (name, value))),
            )
            .envs(env.iter().copied())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .process_group(0);
        let mut child = command.spawn().unwrap();
        {
            // Dropping the handle closes stdin either way. Writes can fail
            // with EPIPE when the daemon already exited: that is a refusal,
            // reported below.
            let mut stdin = child.stdin.take().unwrap();
            if let Some(frame) = binding.and_then(Binding::frame) {
                let _ = stdin.write_all(frame.as_bytes());
            }
        }
        let output = Capture::default();
        for pipe in [
            Box::new(child.stdout.take().unwrap()) as Box<dyn Read + Send>,
            Box::new(child.stderr.take().unwrap()),
        ] {
            let sink = output.clone();
            thread::spawn(move || drain(pipe, sink));
        }
        let socket = fixture.socket();
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            if let Some(status) = child.try_wait().unwrap() {
                thread::sleep(Duration::from_millis(50));
                let output = String::from_utf8_lossy(&output.lock().unwrap()).into_owned();
                return Err(Refused { status, output });
            }
            if UnixStream::connect(&socket).is_ok() {
                return Ok(Self {
                    child: Some(child),
                    output,
                });
            }
            assert!(
                Instant::now() < deadline,
                "relayflowd never bound its socket"
            );
            thread::sleep(Duration::from_millis(20));
        }
    }

    pub fn kill(&mut self) {
        if let Some(mut child) = self.child.take() {
            // SAFETY: kill(2) on a process group touches no memory.
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
            let _ = child.wait();
        }
    }

    pub fn output(&self) -> Vec<u8> {
        self.output.lock().unwrap().clone()
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        self.kill();
    }
}

fn drain(mut pipe: Box<dyn Read + Send>, sink: Capture) {
    let mut buffer = [0u8; 4096];
    while let Ok(read) = pipe.read(&mut buffer) {
        if read == 0 {
            break;
        }
        sink.lock().unwrap().extend_from_slice(&buffer[..read]);
    }
}

/// A protocol connection that records every byte, per direction.
pub struct Wire {
    stream: UnixStream,
    reader: BufReader<UnixStream>,
    next_id: u64,
    events: Vec<Value>,
    sent: Capture,
    received: Capture,
}

impl Wire {
    fn connect(socket: &Path, sent: Capture, received: Capture) -> Self {
        let stream = UnixStream::connect(socket).unwrap();
        let read_half = stream.try_clone().unwrap();
        read_half
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        Self {
            stream,
            reader: BufReader::new(read_half),
            next_id: 1,
            events: vec![],
            sent,
            received,
        }
    }

    pub fn frame(&mut self, verb: &str, params: Value) -> Result<Value> {
        let id = format!("fixture-{}", self.next_id);
        self.next_id += 1;
        let mut line = serde_json::to_vec(&json!({"id": id, "verb": verb, "params": params}))?;
        line.push(b'\n');
        self.sent.lock().unwrap().extend_from_slice(&line);
        self.stream.write_all(&line)?;
        loop {
            let frame = self.read()?;
            if frame.get("event").is_some() {
                self.events.push(frame);
            } else if frame["id"] == id {
                return Ok(frame);
            }
        }
    }

    pub fn request(&mut self, verb: &str, params: Value) -> Result<Value> {
        let frame = self.frame(verb, params)?;
        if frame["ok"] == true {
            return Ok(frame["result"].clone());
        }
        bail!("{}: {}", frame["error"]["code"], frame["error"]["message"])
    }

    /// The refusal code of a request that must be refused.
    pub fn refusal(&mut self, verb: &str, params: Value) -> String {
        let frame = self.frame(verb, params).unwrap();
        assert_eq!(frame["ok"], false, "{verb} was not refused: {frame}");
        frame["error"]["code"].as_str().unwrap().to_owned()
    }

    pub fn event(&mut self, name: &str) -> Value {
        self.try_event(name, Duration::from_secs(30))
            .unwrap_or_else(|| panic!("no {name} event arrived"))
    }

    /// The next `name` event within `wait`, or None.
    pub fn try_event(&mut self, name: &str, wait: Duration) -> Option<Value> {
        if let Some(index) = self.events.iter().position(|frame| frame["event"] == name) {
            return Some(self.events.remove(index)["data"].clone());
        }
        self.reader.get_ref().set_read_timeout(Some(wait)).unwrap();
        let found = loop {
            match self.read() {
                Ok(frame) if frame["event"] == name => break Some(frame["data"].clone()),
                Ok(frame) => self.events.push(frame),
                Err(_) => break None,
            }
        };
        self.reader
            .get_ref()
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        found
    }

    fn read(&mut self) -> Result<Value> {
        let mut line = String::new();
        if self
            .reader
            .read_line(&mut line)
            .context("read protocol frame")?
            == 0
        {
            bail!("protocol connection closed");
        }
        self.received
            .lock()
            .unwrap()
            .extend_from_slice(line.as_bytes());
        serde_json::from_str(&line).context("decode protocol frame")
    }
}

pub fn entries(wire: &mut Wire, run_id: &Value) -> Vec<Value> {
    wire.request("journal.read", json!({"run_id": run_id}))
        .unwrap()["entries"]
        .as_array()
        .unwrap()
        .clone()
}

pub fn stdout_of(wire: &mut Wire, run_id: &Value, step_id: &str) -> String {
    entries(wire, run_id)
        .iter()
        .find(|entry| entry["entry_type"] == "step.completed" && entry["step_id"] == step_id)
        .and_then(|entry| entry["payload"]["output"]["stdout_tail"].as_str())
        .unwrap_or_else(|| panic!("step {step_id} has no completed stdout"))
        .trim()
        .to_owned()
}

/// `cksum` of a value, as `PROBE` prints it inside the step.
pub fn fingerprint(value: &str) -> String {
    let mut child = Command::new("cksum")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child
        .stdin
        .take()
        .unwrap()
        .write_all(value.as_bytes())
        .unwrap();
    let output = child.wait_with_output().unwrap();
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

pub fn contains(haystack: &[u8], needle: &str) -> bool {
    haystack
        .windows(needle.len())
        .any(|window| window == needle.as_bytes())
}

pub fn files_containing(dir: &Path, needle: &str) -> Vec<String> {
    let mut hits = vec![];
    let Ok(listing) = fs::read_dir(dir) else {
        return hits;
    };
    for entry in listing {
        let path = entry.unwrap().path();
        if path.is_dir() {
            hits.extend(files_containing(&path, needle));
        } else if fs::read(&path).is_ok_and(|bytes| contains(&bytes, needle)) {
            hits.push(path.display().to_string());
        }
    }
    hits
}

/// The run the registry admitted under `key` (server-written, durable).
pub fn admitted_run_id(data_dir: &Path, key: &str) -> String {
    let registry = rusqlite::Connection::open(data_dir.join("relayflowd.sqlite3")).unwrap();
    registry
        .query_row(
            "SELECT run_id FROM run_admissions WHERE admission_key = ?1",
            [key],
            |row| row.get(0),
        )
        .unwrap()
}

pub fn wait_for(what: &str, mut condition: impl FnMut() -> bool) {
    let deadline = Instant::now() + Duration::from_secs(15);
    while !condition() {
        assert!(Instant::now() < deadline, "timed out waiting for {what}");
        thread::sleep(Duration::from_millis(20));
    }
}

/// Copy a directory tree: models Cloud archiving the state dir and restoring
/// it into a fresh sandbox (relayflow-v2-state-archive.ts, executor :575-622).
pub fn copy_tree(from: &Path, to: &Path) {
    fs::create_dir_all(to).unwrap();
    for entry in fs::read_dir(from).unwrap() {
        let entry = entry.unwrap();
        let target = to.join(entry.file_name());
        if entry.file_type().unwrap().is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            fs::copy(entry.path(), target).unwrap();
        }
    }
}
