#![cfg(unix)]

use std::{
    os::unix::net::UnixStream,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    thread,
    time::{Duration, Instant},
};

use relayflowd_core::PROTOCOL_VERSION;
use serde_json::Value;
use tempfile::TempDir;

fn start(data_dir: &Path) -> Child {
    Command::new(env!("CARGO_BIN_EXE_relayflowd"))
        .args(["--data-dir", data_dir.to_str().unwrap(), "serve"])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap()
}

fn connection_path(data_dir: &Path) -> PathBuf {
    data_dir.join("connection.json")
}

/// Observe publication and immediately connect; publication is only legal once
/// bind/listen has completed, so every observed file must be connectable.
fn wait_for_connection(data_dir: &Path) -> Value {
    let path = connection_path(data_dir);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if path.exists() {
            let connection: Value = serde_json::from_slice(&std::fs::read(&path).unwrap()).unwrap();
            let socket = connection["socket_path"].as_str().unwrap();
            UnixStream::connect(socket).expect("published connection must already accept");
            return connection;
        }
        assert!(
            Instant::now() < deadline,
            "connection file was never published"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

fn signal(child: &Child, signal: i32) {
    assert_eq!(unsafe { libc::kill(child.id() as i32, signal) }, 0);
}

/// Like `wait_for_connection`, but for a data dir that may still hold a
/// predecessor's stale (unconnectable) file: keeps polling past that file —
/// it is not published until the new pid's socket is live — until a file
/// naming a different pid appears, and only then applies the same
/// connect-must-succeed invariant.
fn wait_for_new_connection(data_dir: &Path, excluding_pid: i32) -> Value {
    let path = connection_path(data_dir);
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if path.exists() {
            if let Ok(bytes) = std::fs::read(&path) {
                if let Ok(connection) = serde_json::from_slice::<Value>(&bytes) {
                    if connection["pid"].as_i64() != Some(excluding_pid as i64) {
                        let socket = connection["socket_path"].as_str().unwrap();
                        UnixStream::connect(socket)
                            .expect("published connection must already accept");
                        return connection;
                    }
                }
            }
        }
        assert!(
            Instant::now() < deadline,
            "successor's connection file was never published"
        );
        thread::sleep(Duration::from_millis(5));
    }
}

#[test]
fn connection_file_is_published_only_after_the_socket_is_live() {
    let directory = TempDir::new().unwrap();
    assert!(!connection_path(directory.path()).exists());
    let mut daemon = start(directory.path());
    let connection = wait_for_connection(directory.path());
    assert_eq!(connection["pid"].as_u64(), Some(daemon.id() as u64));
    assert_eq!(
        connection["protocol"].as_u64(),
        Some(PROTOCOL_VERSION as u64)
    );
    // Socket now lives outside the data dir at a derived path (#262). The
    // anti-hijack invariant is unchanged: the file must name the exact same
    // path the CLI would recompute from --data-dir.
    let expected_socket = relayflowd::socket_path::derive_socket_path(directory.path())
        .expect("derive socket path");
    assert_eq!(
        connection["socket_path"].as_str(),
        expected_socket.to_str(),
    );
    signal(&daemon, libc::SIGTERM);
    assert!(daemon.wait().unwrap().success());
}

#[test]
fn clean_shutdown_removes_advertisement_and_socket() {
    let directory = TempDir::new().unwrap();
    let mut daemon = start(directory.path());
    wait_for_connection(directory.path());
    signal(&daemon, libc::SIGINT);
    assert!(daemon.wait().unwrap().success());
    assert!(!connection_path(directory.path()).exists());
    let socket = relayflowd::socket_path::derive_socket_path(directory.path())
        .expect("derive socket path");
    assert!(!socket.exists());
}

#[test]
fn sigkill_leaves_a_stale_file_with_a_dead_pid() {
    let directory = TempDir::new().unwrap();
    let mut daemon = start(directory.path());
    let connection = wait_for_connection(directory.path());
    let pid = connection["pid"].as_i64().unwrap() as i32;
    signal(&daemon, libc::SIGKILL);
    daemon.wait().unwrap();
    assert!(
        connection_path(directory.path()).exists(),
        "SIGKILL must not invoke cleanup"
    );
    assert_eq!(unsafe { libc::kill(pid, 0) }, -1);
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ESRCH)
    );
}

/// §6 test 4, the anti-hijack test: a second `serve` on a data dir already
/// being served must lose the race cleanly (exit 3, nothing touched), and the
/// first daemon must still be accepting connections afterwards.
#[test]
fn a_second_serve_on_a_served_data_dir_refuses_and_the_first_keeps_serving() {
    let directory = TempDir::new().unwrap();
    let mut first = start(directory.path());
    let first_connection = wait_for_connection(directory.path());

    let mut second = start(directory.path());
    let status = second.wait().unwrap();
    assert_eq!(
        status.code(),
        Some(3),
        "a second daemon on a served data dir must exit 3, got {status:?}"
    );

    // The loser must not have touched the winner's advertisement or socket.
    let still_published: Value =
        serde_json::from_slice(&std::fs::read(connection_path(directory.path())).unwrap())
            .unwrap();
    assert_eq!(still_published, first_connection);
    UnixStream::connect(first_connection["socket_path"].as_str().unwrap())
        .expect("the first daemon must still be accepting connections");

    signal(&first, libc::SIGTERM);
    assert!(first.wait().unwrap().success());
}

/// §6 test 5: a SIGKILL'd daemon's successor starts cleanly — the `flock` is
/// released by the kernel regardless of how the holder died, so the residue
/// left behind (dead socket, stale `connection.json`) must not block a fresh
/// daemon from acquiring the lock, removing that residue, and publishing its
/// own advertisement.
#[test]
fn a_sigkilled_daemons_successor_starts_cleanly() {
    let directory = TempDir::new().unwrap();
    let mut first = start(directory.path());
    let first_connection = wait_for_connection(directory.path());
    let first_pid = first_connection["pid"].as_i64().unwrap() as i32;
    signal(&first, libc::SIGKILL);
    first.wait().unwrap();
    assert!(
        connection_path(directory.path()).exists(),
        "SIGKILL must leave the file behind for the successor to detect"
    );

    let mut second = start(directory.path());
    let second_connection = wait_for_new_connection(directory.path(), first_pid);
    assert_ne!(
        second_connection["pid"].as_i64().unwrap() as i32,
        first_pid,
        "the successor must be a distinct process"
    );
    assert_eq!(
        second_connection["socket_path"],
        first_connection["socket_path"],
        "the successor binds the same socket path"
    );

    signal(&second, libc::SIGTERM);
    assert!(second.wait().unwrap().success());
}

/// #262 regression: a deep working directory used to push
/// `<data-dir>/relayflowd.sock` past SUN_LEN (~104 bytes on macOS). The socket
/// now lives outside the data dir at a short hashed path, so the daemon binds
/// and serves regardless of how deep the data dir is. Padding to well past
/// the limit to prove the property holds by construction, not by accident.
#[test]
fn deep_data_dir_still_binds() {
    let directory = TempDir::new().unwrap();
    let mut deep = directory.path().to_path_buf();
    // Grow the data-dir path well past the ~104-byte macOS ceiling.
    while deep.as_os_str().len() < 200 {
        deep = deep.join("nested-directory-with-a-long-enough-name-to-add-length");
    }
    assert!(
        deep.as_os_str().len() > 104,
        "test fixture must actually exceed SUN_LEN, got {} bytes",
        deep.as_os_str().len(),
    );
    std::fs::create_dir_all(&deep).unwrap();

    let mut daemon = start(&deep);
    let connection = wait_for_connection(&deep);
    let socket = connection["socket_path"].as_str().unwrap();
    // The socket is what the caller must reach, so it is the length that
    // matters — not the data-dir length.
    assert!(
        socket.len() < 104,
        "derived socket path must fit SUN_LEN, got {} bytes: {socket}",
        socket.len(),
    );
    UnixStream::connect(socket).expect("deep-data-dir daemon must accept connections");
    signal(&daemon, libc::SIGTERM);
    assert!(daemon.wait().unwrap().success());
}
