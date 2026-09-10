//! Where the unix-domain socket lives, and why not inside the data dir.
//!
//! `<data-dir>/relayflowd.sock` was the naive location, and it fails hard when
//! the working directory pushes the full socket path past the OS `SUN_LEN`
//! limit (~104 bytes on macOS, ~108 on Linux). A user cloning an example into
//! a nested tree hits `Error: bind socket ...: path must be shorter than
//! SUN_LEN` before any step can run (#262).
//!
//! The daemon socket now binds under `$XDG_RUNTIME_DIR` / `$TMPDIR` /
//! `std::env::temp_dir()` at a short, stable path keyed by a 12-hex-char
//! SHA-256 of the *absolute* data-dir path. Anti-hijack still holds because
//! both the daemon and the CLI derive the same path from the same input:
//! [`derive_socket_path`] is the Rust side, `socketPathFor` in
//! `packages/sdk/src/daemon-connection.ts` is the identical JS side. The
//! `socket_path` field in `connection.json` still names the bound socket, and
//! the client's §2 step-3 check still refuses a file that names anything else.
//!
//! The lock (`relayflowd.lock`), the journal (`relayflowd.sqlite3`), the log
//! (`relayflowd.log`), and `connection.json` continue to live in the data dir
//! — nothing there has a length problem, and moving them would break the
//! `flock(2)`-based mutex that DAEMON-LIFECYCLE.md §3 depends on.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

/// Derive the socket path from the data dir.
///
/// Uses `std::path::absolute` — never `canonicalize` — so the JS side's
/// lexical `path.resolve(dataDir)` produces the same input string. Symlink
/// resolution would introduce a divergence (macOS's `/var` → `/private/var`
/// is the classic one), and the client validates by string equality.
pub fn derive_socket_path(data_dir: &Path) -> Result<PathBuf> {
    let absolute = std::path::absolute(data_dir)
        .with_context(|| format!("make data dir absolute {}", data_dir.display()))?;
    let hash = hash_data_dir(&absolute);
    Ok(runtime_dir().join(format!("relayflowd-{hash}.sock")))
}

fn hash_data_dir(absolute_data_dir: &Path) -> String {
    let mut hasher = Sha256::new();
    hasher.update(absolute_data_dir.as_os_str().as_encoded_bytes());
    let digest = hasher.finalize();
    let mut out = String::with_capacity(12);
    for byte in &digest[..6] {
        use std::fmt::Write;
        // Fixed-width lowercase hex, matching Node's `digest('hex').slice(0, 12)`.
        write!(&mut out, "{byte:02x}").expect("write to String is infallible");
    }
    out
}

fn runtime_dir() -> PathBuf {
    // XDG first (Linux, typically `/run/user/<uid>/`, ~14 chars — the shortest
    // per-user private option). TMPDIR next (macOS, `/var/folders/xx/YYY/T/`,
    // ~50 chars, still per-user private). Only fall back to the system-wide
    // `std::env::temp_dir()` when neither is set; on macOS that resolves to
    // `/var/folders/.../T` too, and on Linux to `/tmp` which is world-writable.
    if let Some(value) = env_nonempty("XDG_RUNTIME_DIR") {
        return PathBuf::from(value);
    }
    if let Some(value) = env_nonempty("TMPDIR") {
        return PathBuf::from(value);
    }
    std::env::temp_dir()
}

fn env_nonempty(name: &str) -> Option<std::ffi::OsString> {
    match std::env::var_os(name) {
        Some(value) if !value.is_empty() => Some(value),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_data_dir_yields_same_socket() {
        let a = derive_socket_path(Path::new("/tmp/deep")).unwrap();
        let b = derive_socket_path(Path::new("/tmp/deep")).unwrap();
        assert_eq!(a, b);
    }

    #[test]
    fn different_data_dirs_yield_different_sockets() {
        let a = derive_socket_path(Path::new("/tmp/one")).unwrap();
        let b = derive_socket_path(Path::new("/tmp/two")).unwrap();
        assert_ne!(a, b);
    }

    #[test]
    fn deep_data_dir_produces_short_socket_path() {
        // The whole point of #262: the socket path stays short regardless of
        // how deep the data dir is. Assert against a padding well past the
        // 104-byte macOS SUN_LEN.
        let deep = "/tmp/".to_string() + &"a/".repeat(80) + "data";
        assert!(deep.len() > 104);
        let socket = derive_socket_path(Path::new(&deep)).unwrap();
        // The socket path is bounded by `<runtime_dir> + "/relayflowd-" +
        // 12 hex chars + ".sock"`, which is ~60 chars on macOS worst case.
        assert!(
            socket.as_os_str().len() < 104,
            "derived socket path must fit SUN_LEN, got {} bytes: {}",
            socket.as_os_str().len(),
            socket.display(),
        );
    }

    #[test]
    fn relative_and_absolute_data_dirs_agree() {
        // A caller passing a relative `--data-dir` must produce the same
        // socket as a caller passing the same absolute path, or the CLI's
        // lexical anti-hijack check would refuse a matching daemon.
        // `absolute` resolves relative paths against the process CWD, and
        // that is exactly what Node's `path.resolve` does on the other side.
        let cwd = std::env::current_dir().unwrap();
        let absolute = cwd.join("some-data");
        assert_eq!(
            derive_socket_path(Path::new("some-data")).unwrap(),
            derive_socket_path(&absolute).unwrap(),
        );
    }
}
