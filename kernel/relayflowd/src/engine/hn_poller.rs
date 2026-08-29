use std::process::Command;

use anyhow::{bail, Context, Result};
use relayflowd_core::{Clock, Event, RunSpec};
use serde_json::json;

use super::{Engine, EventSubmitOutcome};

const TOP_STORIES_URL: &str = "https://hacker-news.firebaseio.com/v0/topstories.json";
const DEFAULT_STORY_LIMIT: usize = 5;

/// Fetches one snapshot of Hacker News top stories and submits it to a flow.
#[derive(Debug, Clone, Copy)]
pub struct HnPoller {
    story_limit: usize,
}

impl HnPoller {
    pub fn new(story_limit: usize) -> Self {
        Self { story_limit }
    }

    pub fn poll_once<C: Clock>(
        &self,
        engine: &Engine<C>,
        spec: RunSpec,
        created_by: &str,
    ) -> Result<Vec<EventSubmitOutcome>> {
        let payload = fetch_top_stories()?;
        self.poll_payload(engine, spec, created_by, &payload)
    }

    /// Submits a recorded top-stories response without performing network I/O.
    pub fn poll_payload<C: Clock>(
        &self,
        engine: &Engine<C>,
        spec: RunSpec,
        created_by: &str,
        payload: &str,
    ) -> Result<Vec<EventSubmitOutcome>> {
        let story_ids: Vec<u64> =
            serde_json::from_str(payload).context("parse HN top stories response")?;
        story_ids
            .into_iter()
            .take(self.story_limit)
            .map(|id| {
                engine.submit_event(
                    spec.clone(),
                    Event {
                        event_type: "hn.story_posted".into(),
                        payload: json!({"id": id, "type": "story"}),
                        key: None,
                    },
                    created_by,
                )
            })
            .collect()
    }
}

impl Default for HnPoller {
    fn default() -> Self {
        Self::new(DEFAULT_STORY_LIMIT)
    }
}

fn fetch_top_stories() -> Result<String> {
    let output = Command::new("curl")
        .args(["--fail", "--silent", "--show-error", TOP_STORIES_URL])
        .output()
        .context("fetch HN top stories")?;
    if !output.status.success() {
        bail!(
            "fetch HN top stories failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
    }
    String::from_utf8(output.stdout).context("HN top stories response was not UTF-8")
}
