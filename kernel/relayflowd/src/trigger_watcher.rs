//! Local inbox ingress. Each `triggers/<name>.json` is a compiled RunSpec whose
//! event_type and executor equal <name>. Provision these files before ingress;
//! do not change a binding while its inbox is pending (dedupe is spec-scoped).
//! TODO https://github.com/AgentWorkforce/flows/issues/301: bind sealed bundles
//! through flows deploy; TS handler deployment and Cloud mounts are separate.
//! No author process stays alive between events. The daemon polls at 1 Hz.

use crate::engine::{EventSubmitOutcome, read_spec};
use anyhow::{Context, Result, bail};
use relayflowd_core::{Event, RunSpec};
use std::{
    fs,
    path::{Path, PathBuf},
    thread,
    time::Duration,
};

const MAX_EVENT_BYTES: u64 = 1024 * 1024;

pub fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 128
        && name.as_bytes()[0].is_ascii_alphanumeric()
        && name
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || c == b'_' || c == b'-')
}

/// The callback is the engine boundary; filesystem traversal never executes code.
/// Errors retain the offending file and do not starve other inboxes.
pub fn poll_once(
    data_dir: &Path,
    submit: &mut impl FnMut(RunSpec, Event) -> Result<EventSubmitOutcome>,
) -> Result<Vec<String>> {
    let inbox = data_dir.join("inbox");
    fs::create_dir_all(&inbox)?;
    let mut errors = Vec::new();
    for directory in fs::read_dir(&inbox)? {
        let directory = directory?;
        if !directory.file_type()?.is_dir() {
            continue;
        }
        let Some(name) = directory.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        if !valid_name(&name) {
            continue;
        }
        for file in fs::read_dir(directory.path())? {
            let file = file?;
            if !file.file_type()?.is_file() {
                continue;
            }
            let filename = file.file_name();
            let Some(filename) = filename.to_str() else {
                continue;
            };
            let Some(id) = filename.strip_suffix(".json") else {
                continue;
            };
            if !valid_name(id) {
                continue;
            }
            if let Err(error) = process_file(data_dir, &name, filename, &file.path(), submit) {
                errors.push(format!("{}: {error:#}", file.path().display()));
            }
        }
    }
    Ok(errors)
}

fn process_file(
    data_dir: &Path,
    name: &str,
    filename: &str,
    path: &Path,
    submit: &mut impl FnMut(RunSpec, Event) -> Result<EventSubmitOutcome>,
) -> Result<()> {
    if fs::metadata(path)?.len() > MAX_EVENT_BYTES {
        bail!("event exceeds 1 MiB");
    }
    let event = Event {
        event_type: name.to_owned(),
        payload: serde_json::from_slice(&fs::read(path)?).context("parse inbox event")?,
        key: Some(filename.to_owned()),
    };
    let binding = data_dir.join("triggers").join(format!("{name}.json"));
    if !fs::symlink_metadata(&binding)?.is_file() {
        bail!("trigger binding must be a regular file");
    }
    let spec = read_spec(&binding)?;
    spec.validate().context("invalid trigger spec")?;
    if spec.triggers.is_empty()
        || spec
            .triggers
            .iter()
            .any(|trigger| trigger.executor != name || trigger.event_type.as_deref() != Some(name))
    {
        bail!("trigger binding must declare executor and event_type {name:?}");
    }
    let outcome = submit(spec, event)?;
    // A nonmatch is a consumed filter rejection. A matched submission must be
    // durable and driven (or resumed) before moving: crash-before-move retries.
    if outcome.matched && outcome.run.is_none() {
        bail!("matched event has no durable run receipt");
    }
    let processed = data_dir.join("inbox-processed").join(name);
    fs::create_dir_all(&processed)?;
    if !fs::symlink_metadata(&processed)?.is_dir() {
        bail!("processed inbox must be a directory");
    }
    fs::rename(path, processed.join(filename)).context("archive inbox event")?;
    fs::File::open(&processed)?.sync_all()?;
    fs::File::open(path.parent().context("inbox parent")?)?.sync_all()?;
    Ok(())
}

pub(crate) fn spawn_watcher(
    data_dir: PathBuf,
    mut submit: impl FnMut(RunSpec, Event) -> Result<EventSubmitOutcome> + Send + 'static,
) {
    thread::spawn(move || {
        loop {
            match poll_once(&data_dir, &mut submit) {
                Ok(errors) => {
                    for error in errors {
                        eprintln!("relayflowd: inbox retained: {error}");
                    }
                }
                Err(error) => eprintln!("relayflowd: inbox poll failed: {error:#}"),
            }
            // TODO https://github.com/AgentWorkforce/flows/issues/301: native watch
            // notifications are a follow-up; this slice deliberately polls at 1 Hz.
            thread::sleep(Duration::from_secs(1));
        }
    });
}
