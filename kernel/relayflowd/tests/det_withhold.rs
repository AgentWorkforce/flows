//! `relayflowd serve --det-withhold`: real daemon processes, real `f.run`
//! child processes that dump their whole environment to a file OUTSIDE the
//! data dir, and the names checked by name AND by value bytes.

use std::{
    fs,
    io::{BufRead, BufReader, Write},
    os::unix::{net::UnixStream, process::CommandExt},
    path::{Path, PathBuf},
    process::{Child, Command, Output, Stdio},
    time::{Duration, Instant},
};

use serde_json::{Value, json};
use tempfile::{TempDir, tempdir};

/// Cloud's tracked agent/house set today (20 names), passed as a list.
const TRACKED: &[&str] = &[
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
    "CODEX_HOME",
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_BASE_URL",
    "OPENAI_API_KEY",
    "OPENAI_BASE_URL",
    "OPENAI_API_BASE",
    "OPENROUTER_API_KEY",
    "GOOGLE_API_KEY",
    "GOOGLE_API_BASE",
    "RELAY_BASE_URL",
    "RELAY_AGENT_TOKEN",
    "CURSOR_API_KEY",
    "CURSOR_API_BASE_URL",
    "CURSOR_API_ENDPOINT",
    "XAI_API_KEY",
    "GROK_XAI_API_BASE_URL",
    "GROK_HOME",
    "HOUSE_PROXY_CREDENTIAL",
];
/// Ordinary names in both Cloud envs: they keep reaching steps.
const ORDINARY: &[(&str, &str)] = &[
    ("GH_CONFIG_DIR", "/fixture/gh-config"),
    ("GIT_CONFIG_NOSYSTEM", "1"),
    ("DELIVERED_SECRET", "delivered-fixture-value-81Jx"),
];

fn fake(name: &str) -> String {
    format!("fixture-{}-value-7Q2w", name.to_ascii_lowercase())
}

fn flag() -> String {
    TRACKED.join(",")
}

struct Fixture {
    _dir: TempDir,
    data: PathBuf,
    scratch: PathBuf,
}

impl Fixture {
    fn new() -> Self {
        let dir = tempdir().unwrap();
        let data = dir.path().join("data");
        let scratch = dir.path().join("scratch");
        fs::create_dir_all(&scratch).unwrap();
        Self {
            _dir: dir,
            data,
            scratch,
        }
    }

    fn socket(&self) -> PathBuf {
        relayflowd::socket_path::derive_socket_path(&self.data).unwrap()
    }

    fn command(&self, args: &[&str], env: &[(String, String)]) -> Command {
        let mut command = Command::new(env!("CARGO_BIN_EXE_relayflowd"));
        command
            .args(["--data-dir", self.data.to_str().unwrap(), "serve"])
            .args(args)
            .env_clear()
            .env("PATH", std::env::var("PATH").unwrap_or_default())
            .env("HOME", &self.scratch)
            .envs(
                ["XDG_RUNTIME_DIR", "TMPDIR"]
                    .into_iter()
                    .filter_map(|name| {
                        std::env::var(name)
                            .ok()
                            .map(|value| (name.to_owned(), value))
                    }),
            )
            .envs(env.iter().cloned())
            .stdin(Stdio::null())
            .process_group(0);
        command
    }

    fn serve(&self, args: &[&str], env: &[(String, String)]) -> Daemon {
        let mut child = self
            .command(args, env)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(15);
        while UnixStream::connect(self.socket()).is_err() {
            assert!(child.try_wait().unwrap().is_none(), "relayflowd exited");
            assert!(
                Instant::now() < deadline,
                "relayflowd never bound its socket"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        Daemon(Some(child))
    }

    /// Run a daemon that must refuse to start. One that serves instead is
    /// killed and reported, never waited on forever.
    fn refused(&self, args: &[&str]) -> Output {
        let child = self
            .command(args, &[])
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let pid = child.id();
        let (done, finished) = std::sync::mpsc::channel::<()>();
        let watchdog = std::thread::spawn(move || {
            if finished.recv_timeout(Duration::from_secs(5)).is_err() {
                // SAFETY: kill(2) on a process group touches no memory; the
                // child has not been reaped yet, so the pid is still its own.
                unsafe { libc::kill(-(pid as i32), libc::SIGKILL) };
            }
        });
        let output = child.wait_with_output().unwrap();
        let _ = done.send(());
        watchdog.join().unwrap();
        assert!(
            output.status.code().is_some(),
            "relayflowd started and served instead of refusing {args:?}"
        );
        output
    }

    fn connect(&self) -> Client {
        let stream = UnixStream::connect(self.socket()).unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(30)))
            .unwrap();
        Client {
            reader: BufReader::new(stream.try_clone().unwrap()),
            stream,
            next: 0,
        }
    }

    fn dump(&self, name: &str) -> PathBuf {
        self.scratch.join(name)
    }
}

struct Daemon(Option<Child>);

impl Daemon {
    fn kill(&mut self) {
        if let Some(mut child) = self.0.take() {
            // SAFETY: kill(2) on a process group touches no memory.
            unsafe { libc::kill(-(child.id() as i32), libc::SIGKILL) };
            let _ = child.wait();
        }
    }
}

impl Drop for Daemon {
    fn drop(&mut self) {
        self.kill();
    }
}

struct Client {
    stream: UnixStream,
    reader: BufReader<UnixStream>,
    next: u64,
}

impl Client {
    fn request(&mut self, verb: &str, params: Value) -> Value {
        self.next += 1;
        let id = format!("withhold-{}", self.next);
        let mut line =
            serde_json::to_vec(&json!({"id": id, "verb": verb, "params": params})).unwrap();
        line.push(b'\n');
        self.stream.write_all(&line).unwrap();
        loop {
            let mut text = String::new();
            assert!(
                self.reader.read_line(&mut text).unwrap() > 0,
                "connection closed"
            );
            let frame: Value = serde_json::from_str(&text).unwrap();
            if frame["id"] == id {
                assert_eq!(frame["ok"], true, "{verb} failed: {frame}");
                return frame["result"].clone();
            }
        }
    }

    fn hello(&mut self) -> Value {
        self.request(
            "hello",
            json!({"protocol": relayflowd_core::PROTOCOL_VERSION, "client": "det-withhold-test"}),
        )
    }

    fn start(&mut self, steps: Value, env: Option<Value>) -> Value {
        let mut params = json!({"spec": {"name": "det-withhold", "steps": steps}});
        if let Some(env) = env {
            params["env"] = env;
        }
        self.request("run.start", params)
    }
}

/// What a Cloud CLI sends as `run.start.env`: tracked agent keys plus
/// ordinary names.
fn cli_env() -> Value {
    let mut env = json!({"PATH": std::env::var("PATH").unwrap_or_default()});
    for name in TRACKED {
        env[*name] = json!(fake(name));
    }
    for (name, value) in ORDINARY {
        env[*name] = json!(value);
    }
    env
}

fn dump_step(id: &str, path: &Path) -> Value {
    json!({"id": id, "type": "deterministic", "command": format!("env > '{}'", path.display())})
}

/// Assert no tracked name or value is in the dump, and every ordinary one is.
fn assert_withheld(path: &Path) {
    let text = fs::read_to_string(path).unwrap();
    for name in TRACKED {
        assert!(
            !text
                .lines()
                .any(|line| line.starts_with(&format!("{name}="))),
            "{name} reached a det step ({})",
            path.display()
        );
        assert!(
            !text.contains(&fake(name)),
            "{name}'s value reached a det step"
        );
    }
    for (name, value) in ORDINARY {
        assert!(text.contains(&format!("{name}={value}")), "{name} was lost");
    }
}

#[test]
fn withheld_names_never_reach_a_det_step_of_any_run() {
    let fixture = Fixture::new();
    let _daemon = fixture.serve(&["--det-withhold", &flag()], &[]);
    let hello = fixture.connect().hello();
    let mut sorted = TRACKED.to_vec();
    sorted.sort();
    assert_eq!(hello["det_withheld"], json!(sorted), "{hello}");
    // Two runs on two connections, both sending the CLI env.
    for name in ["first.env", "second.env"] {
        let run = fixture.connect().start(
            json!([dump_step("dump", &fixture.dump(name))]),
            Some(cli_env()),
        );
        assert_eq!(run["status"], "completed", "{run}");
        assert_withheld(&fixture.dump(name));
    }
}

#[cfg(target_os = "linux")]
/// The daemon's env as a host or a first CLI might give it: every withheld
/// value, ordinary names, and a marker proving /proc/<pid>/environ is read.
fn exported_daemon_env() -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = TRACKED
        .iter()
        .map(|name| ((*name).to_owned(), fake(name)))
        .collect();
    env.extend(
        ORDINARY
            .iter()
            .map(|(n, v)| ((*n).to_owned(), (*v).to_owned())),
    );
    env.push(("DAEMON_MARKER".to_owned(), "daemon-marker-4Hq".to_owned()));
    env
}

#[cfg(target_os = "linux")]
/// A step that copies its parent's (the daemon's) /proc environ to a file.
fn parent_environ_step(id: &str, path: &Path) -> Value {
    json!({"id": id, "type": "deterministic",
           "command": format!("tr '\\0' '\\n' < /proc/$PPID/environ > '{}'", path.display())})
}

#[cfg(target_os = "linux")]
/// The daemon's /proc environ, as read by a same-uid process: readable (the
/// marker is there), and no withheld name or value in it.
fn assert_clean_environ(path: &Path) {
    let text = fs::read_to_string(path).unwrap();
    assert!(
        text.contains("DAEMON_MARKER=daemon-marker-4Hq"),
        "control: the daemon's environ was not read:\n{text}"
    );
    for name in TRACKED {
        assert!(
            !text.contains(&fake(name))
                && !text.lines().any(|l| l.starts_with(&format!("{name}="))),
            "the daemon's /proc environ still holds {name}"
        );
    }
}

// /proc and the clean re-exec are Linux-only; elsewhere a daemon holding a
// withheld value refuses to start instead.
#[cfg(target_os = "linux")]
#[test]
fn a_daemon_exported_withheld_values_execs_itself_clean_before_serving() {
    let fixture = Fixture::new();
    let daemon = fixture.serve(&["--det-withhold", &flag()], &exported_daemon_env());
    // Read directly by the test process (same uid as every step).
    let pid = daemon.0.as_ref().unwrap().id();
    fs::write(
        fixture.dump("direct.environ"),
        fs::read(format!("/proc/{pid}/environ"))
            .unwrap()
            .split(|b| *b == 0)
            .map(|var| String::from_utf8_lossy(var).into_owned())
            .collect::<Vec<_>>()
            .join("\n"),
    )
    .unwrap();
    assert_clean_environ(&fixture.dump("direct.environ"));
    // From inside steps: an env-free client (which inherits the daemon env)
    // and a legacy client that still sends the agent keys.
    for (name, env) in [("env-free", None), ("legacy-sdk", Some(cli_env()))] {
        let environ = fixture.dump(&format!("{name}.environ"));
        let inherited = fixture.dump(&format!("{name}.env"));
        let run = fixture.connect().start(
            json!([
                parent_environ_step("peek", &environ),
                dump_step("dump", &inherited)
            ]),
            env,
        );
        assert_eq!(run["status"], "completed", "{run}");
        assert_clean_environ(&environ);
        assert_withheld(&inherited);
    }
}

// /proc and the clean re-exec are Linux-only; elsewhere a daemon holding a
// withheld value refuses to start instead.
#[cfg(target_os = "linux")]
#[test]
fn a_restarted_daemon_given_the_same_env_execs_clean_again() {
    let fixture = Fixture::new();
    let mut daemon = fixture.serve(&["--det-withhold", &flag()], &exported_daemon_env());
    daemon.kill();
    let _restarted = fixture.serve(&["--det-withhold", &flag()], &exported_daemon_env());
    let environ = fixture.dump("restarted.environ");
    let run = fixture
        .connect()
        .start(json!([parent_environ_step("peek", &environ)]), None);
    assert_eq!(run["status"], "completed", "{run}");
    assert_clean_environ(&environ);
}

#[test]
fn an_env_free_client_inherits_a_daemon_env_without_withheld_values() {
    let fixture = Fixture::new();
    let ordinary: Vec<(String, String)> = ORDINARY
        .iter()
        .map(|(n, v)| ((*n).to_owned(), (*v).to_owned()))
        .collect();
    let _daemon = fixture.serve(&["--det-withhold", &flag()], &ordinary);
    let run = fixture.connect().start(
        json!([dump_step("dump", &fixture.dump("legacy.env"))]),
        None,
    );
    assert_eq!(run["status"], "completed", "{run}");
    assert_withheld(&fixture.dump("legacy.env"));
}

#[test]
fn a_retried_attempt_is_stripped() {
    let fixture = Fixture::new();
    let _daemon = fixture.serve(&["--det-withhold", &flag()], &[]);
    let marker = fixture.dump("first-attempt");
    let dumped = fixture.dump("retry.env");
    // Attempt 1 fails; attempt 2 dumps its env.
    let command = format!(
        "if [ ! -f '{m}' ]; then touch '{m}'; exit 1; fi; env > '{d}'",
        m = marker.display(),
        d = dumped.display()
    );
    let step = json!({"id": "retry", "type": "deterministic", "command": command,
                      "max_iterations": 2,
                      "retry": {"initial_backoff_ms": 0, "max_backoff_ms": 0,
                                "multiplier": 1, "jitter_percent": 0}});
    let run = fixture.connect().start(json!([step]), Some(cli_env()));
    assert_eq!(run["status"], "completed", "{run}");
    assert!(marker.exists(), "attempt 1 never ran");
    assert_withheld(&dumped);
}

#[test]
fn a_restarted_daemon_with_the_same_flag_strips_the_resumed_run() {
    let fixture = Fixture::new();
    let mut daemon = fixture.serve(&["--det-withhold", &flag()], &[]);
    let started = fixture.dump("gate.started");
    let gate = fixture.dump("gate");
    let wait = format!(
        "touch '{}'; while [ ! -f '{}' ]; do sleep 0.02; done",
        started.display(),
        gate.display()
    );
    let steps = json!([
        {"id": "gate", "type": "deterministic", "command": wait},
        {"id": "dump", "type": "deterministic", "depends_on": ["gate"],
         "command": format!("env > '{}'", fixture.dump("resumed.env").display())},
    ]);
    let mut client = fixture.connect();
    let blocked = std::thread::spawn(move || {
        let mut params = json!({"spec": {"name": "det-withhold", "steps": steps}});
        params["env"] = cli_env();
        // The connection dies with the daemon; the run is resumed below.
        let _ = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            client.request("run.start", params)
        }));
    });
    let deadline = Instant::now() + Duration::from_secs(15);
    while !started.exists() {
        assert!(Instant::now() < deadline, "the gate never started");
        std::thread::sleep(Duration::from_millis(20));
    }
    daemon.kill();
    blocked.join().unwrap();
    fs::write(&gate, b"").unwrap();
    let _restarted = fixture.serve(&["--det-withhold", &flag()], &[]);
    let run_id = fs::read_dir(fixture.data.join("runs"))
        .unwrap()
        .find_map(|entry| {
            let name = entry.unwrap().file_name().into_string().unwrap();
            name.strip_suffix(".sqlite3").map(str::to_owned)
        })
        .expect("the interrupted run");
    let resumed = fixture
        .connect()
        .request("run.resume", json!({"run_id": run_id, "env": cli_env()}));
    assert_eq!(resumed["status"], "completed", "{resumed}");
    assert_withheld(&fixture.dump("resumed.env"));
}

#[test]
fn without_the_flag_nothing_changes() {
    let fixture = Fixture::new();
    let _daemon = fixture.serve(&[], &[]);
    let hello = fixture.connect().hello();
    assert!(hello.get("det_withheld").is_none(), "{hello}");
    let run = fixture.connect().start(
        json!([dump_step("dump", &fixture.dump("plain.env"))]),
        Some(cli_env()),
    );
    assert_eq!(run["status"], "completed", "{run}");
    let text = fs::read_to_string(fixture.dump("plain.env")).unwrap();
    for name in TRACKED {
        assert!(
            text.contains(&format!("{name}={}", fake(name))),
            "{name} changed"
        );
    }
}

#[test]
fn an_empty_malformed_or_protected_list_refuses_to_start() {
    let fixture = Fixture::new();
    for (arg, code, name) in [
        ("", "withhold_empty", ""),
        ("OPENAI_API_KEY,,XAI_API_KEY", "withhold_invalid", ""),
        ("OPENAI_API_KEY,bad-name", "withhold_invalid", "bad-name"),
        ("OPENAI_API_KEY,PATH", "withhold_protected", "PATH"),
        ("LD_PRELOAD", "withhold_protected", "LD_PRELOAD"),
        ("HOME", "withhold_protected", "HOME"),
    ] {
        let output = fixture.refused(&["--det-withhold", arg]);
        let said = String::from_utf8_lossy(&output.stderr);
        assert_eq!(output.status.code(), Some(78), "{arg:?}: {said}");
        assert!(
            said.contains(code) && said.contains(&format!("{name:?}")),
            "{arg:?}: {said}"
        );
        assert!(!fixture.socket().exists(), "{arg:?} bound a socket");
    }
}
