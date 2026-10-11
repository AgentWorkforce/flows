//! The frame ack/refusal line on `--det-ack-fd` (wire §1.3). Exactly one
//! line, then the descriptor is closed; never the socket.

use std::{fs::File, io::Write, os::fd::FromRawFd};

use serde_json::json;

use super::{DetBinding, Refusal};

/// Exit status for a refused frame (EX_CONFIG).
pub const REFUSED_EXIT: i32 = 78;

pub struct AckFd(File);

impl AckFd {
    /// Adopt an inherited, writable descriptor `fd >= 3`.
    pub fn adopt(fd: i32) -> Result<Self, Refusal> {
        let invalid = || Refusal::new("ack_fd_invalid", "det-ack-fd");
        if fd < 3 {
            return Err(invalid());
        }
        // SAFETY: fcntl(F_GETFL) only queries the descriptor table.
        let flags = unsafe { libc::fcntl(fd, libc::F_GETFL) };
        if flags < 0 || flags & libc::O_ACCMODE == libc::O_RDONLY {
            return Err(invalid());
        }
        // SAFETY: the descriptor is open and writable (checked above) and this
        // process takes sole ownership of it from here on.
        let file = unsafe { File::from_raw_fd(fd) };
        // Never leak it into spawned steps.
        // SAFETY: fcntl(F_SETFD) only changes this descriptor's flags.
        unsafe { libc::fcntl(fd, libc::F_SETFD, libc::FD_CLOEXEC) };
        Ok(Self(file))
    }

    pub fn accepted(mut self, binding: &DetBinding) -> std::io::Result<()> {
        let line = json!({
            "det_frame": "accepted",
            "version": 1,
            "credentials": binding.credentials.keys().collect::<Vec<_>>(),
            "withhold_count": binding.withhold.len(),
            "root_admission_key": binding.pins.root_admission_key,
        });
        writeln!(self.0, "{line}")
    }

    pub fn refused(mut self, refusal: &Refusal) -> std::io::Result<()> {
        writeln!(self.0, "{}", refusal_line(refusal))
    }
}

pub fn refusal_line(refusal: &Refusal) -> String {
    json!({"det_frame": "refused", "code": refusal.code, "field": refusal.field}).to_string()
}
