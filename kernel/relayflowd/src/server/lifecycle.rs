//! Filesystem ownership and advertisement for a serving daemon.

use std::{
    ffi::CString,
    fs::{File, OpenOptions},
    io::{self, Write},
    os::{
        raw::{c_char, c_int},
        unix::{fs::OpenOptionsExt, io::AsRawFd},
    },
    path::Path,
    ptr,
    sync::atomic::{AtomicPtr, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};

use anyhow::{Context, Result};
use relayflowd_core::PROTOCOL_VERSION;
use serde::Serialize;

static CONNECTION_PATH: AtomicPtr<c_char> = AtomicPtr::new(ptr::null_mut());
static SOCKET_PATH: AtomicPtr<c_char> = AtomicPtr::new(ptr::null_mut());

/// Keep this value alive for the entire `serve` call.
pub(crate) struct DaemonLock {
    _file: File,
}

#[derive(Debug)]
pub(crate) enum AcquireError {
    AlreadyServing,
    Io(io::Error),
}

impl std::fmt::Display for AcquireError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::AlreadyServing => f.write_str("another relayflowd is already serving"),
            Self::Io(error) => error.fmt(f),
        }
    }
}
impl std::error::Error for AcquireError {}

pub(crate) fn acquire(data_dir: &Path) -> std::result::Result<DaemonLock, AcquireError> {
    let lock = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .mode(0o600)
        .open(data_dir.join("relayflowd.lock"))
        .map_err(AcquireError::Io)?;
    if unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
        return Ok(DaemonLock { _file: lock });
    }
    let error = io::Error::last_os_error();
    if error.kind() == io::ErrorKind::WouldBlock {
        Err(AcquireError::AlreadyServing)
    } else {
        Err(AcquireError::Io(error))
    }
}

/// Safe only after `acquire`: no other daemon can own these paths.
pub(crate) fn remove_residue(data_dir: &Path) -> Result<()> {
    for name in ["relayflowd.sock", "connection.json"] {
        let path = data_dir.join(name);
        match std::fs::remove_file(&path) {
            Ok(()) => {}
            Err(error) if error.kind() == io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(error).with_context(|| format!("remove stale {}", path.display()));
            }
        }
    }
    Ok(())
}

#[derive(Serialize)]
struct ConnectionFile<'a> {
    socket_path: &'a str,
    pid: u32,
    version: &'a str,
    protocol: u32,
    started_at_ms: u128,
}

/// Publish only after `UnixListener::bind`, which has already called listen(2).
pub(crate) fn publish(socket_path: &Path) -> Result<()> {
    // `absolute` preserves the caller's data-dir spelling (unlike
    // `canonicalize`, which would turn `/var` into macOS's `/private/var` and
    // fail the client's lexical `resolve(dataDir)` comparison).
    let socket_path = std::path::absolute(socket_path)
        .with_context(|| format!("make socket path absolute {}", socket_path.display()))?;
    let socket_text = socket_path
        .to_str()
        .context("socket path is not valid UTF-8")?;
    let data_dir = socket_path.parent().context("socket path has no parent")?;
    let connection_path = data_dir.join("connection.json");
    let temporary_path = data_dir.join(format!("connection.json.tmp.{}", std::process::id()));
    let record = ConnectionFile {
        socket_path: socket_text,
        pid: std::process::id(),
        version: env!("CARGO_PKG_VERSION"),
        protocol: PROTOCOL_VERSION,
        started_at_ms: SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis(),
    };
    let bytes = serde_json::to_vec(&record)?;
    let result = (|| -> Result<()> {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary_path)
            .with_context(|| format!("create {}", temporary_path.display()))?;
        file.write_all(&bytes)?;
        file.sync_all()?;
        // Register before making the advertisement visible. A caller may send
        // SIGTERM the instant rename returns, so visibility must imply cleanup
        // is already installed.
        install_cleanup_handlers(&connection_path, &socket_path)?;
        std::fs::rename(&temporary_path, &connection_path)
            .with_context(|| format!("publish {}", connection_path.display()))?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(&temporary_path);
    }
    result
}

fn install_cleanup_handlers(connection_path: &Path, socket_path: &Path) -> Result<()> {
    // These strings remain valid until the signal handler calls `_exit`.
    let connection = CString::new(connection_path.as_os_str().as_encoded_bytes())?;
    let socket = CString::new(socket_path.as_os_str().as_encoded_bytes())?;
    CONNECTION_PATH.store(connection.into_raw(), Ordering::Relaxed);
    SOCKET_PATH.store(socket.into_raw(), Ordering::Relaxed);
    unsafe {
        if libc::signal(libc::SIGTERM, on_terminate as *const () as usize) == libc::SIG_ERR
            || libc::signal(libc::SIGINT, on_terminate as *const () as usize) == libc::SIG_ERR
        {
            return Err(io::Error::last_os_error().into());
        }
    }
    Ok(())
}

extern "C" fn on_terminate(_signal: c_int) {
    for slot in [&CONNECTION_PATH, &SOCKET_PATH] {
        let path = slot.load(Ordering::Relaxed);
        if !path.is_null() {
            unsafe { libc::unlink(path) };
        }
    }
    unsafe { libc::_exit(0) }
}
