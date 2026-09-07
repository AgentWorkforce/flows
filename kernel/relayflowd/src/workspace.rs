//! Local worktree facts at the I/O edge. This is not a sandbox provisioner.
use anyhow::{Context, Result, bail};
use relayflowd_core::{Pins, StepKind, StepSpec, WorkspacePin};
use std::{path::Path, process::Command};

pub(crate) fn pin(path: &Path) -> Result<WorkspacePin> {
    let path = path
        .canonicalize()
        .with_context(|| format!("workspace {} is unavailable", path.display()))?;
    let output = Command::new("git")
        .args(["rev-parse", "--verify", "HEAD^{commit}"])
        .current_dir(&path)
        .output()
        .context("read workspace base commit")?;
    if !output.status.success() {
        bail!(
            "workspace {} has no readable base commit: {}",
            path.display(),
            String::from_utf8_lossy(&output.stderr)
        );
    }
    let revision_id = String::from_utf8(output.stdout)?.trim().to_owned();
    if revision_id.is_empty() {
        bail!("workspace base commit is empty");
    }
    Ok(WorkspacePin {
        surface: path
            .to_str()
            .context("workspace path is not UTF-8")?
            .to_owned(),
        revision_id,
    })
}

/// Default in-process dispatcher pins declared worktrees. Remote dispatchers
/// override this with relayfile revision facts from their selected worker.
pub(crate) fn starting_pins(step: &StepSpec) -> Result<Pins> {
    let mut pins = Pins::default();
    if let StepKind::Agent { surfaces, .. } = &step.kind {
        for surface in &surfaces.workspace {
            let mut pinned = pin(Path::new(&surface.surface))?;
            pinned.surface = surface.surface.clone();
            pins.workspace.push(pinned);
        }
        if !surfaces.streams.is_empty() {
            bail!("dispatcher must report declared stream offsets");
        }
    }
    Ok(pins)
}
