use anyhow::{Context, Result};
use relayflowd_core::{Clock, Event, RunSpec};
use serde_json::json;

use super::{Engine, EventSubmitOutcome};

const TOP_STORIES_URL: &str = "https://hacker-news.firebaseio.com/v0/topstories.json";
const DEFAULT_STORY_LIMIT: usize = 5;

/// One-shot adapter from Hacker News' top-stories feed to relayflow events.
pub struct HnPoller {
    spec: RunSpec,
    story_limit: usize,
}

impl HnPoller {
    pub fn new(spec: RunSpec) -> Self {
        Self {
            spec,
            story_limit: DEFAULT_STORY_LIMIT,
        }
    }

    pub fn with_story_limit(mut self, story_limit: usize) -> Self {
        self.story_limit = story_limit;
        self
    }

    pub fn poll_once<C: Clock>(
        &self,
        engine: &Engine<C>,
        created_by: &str,
    ) -> Result<Vec<EventSubmitOutcome>> {
        self.poll_once_with(engine, created_by, |url| {
            ureq::get(url)
                .call()
                .context("fetch HN top stories")?
                .into_string()
                .context("read HN top stories response")
        })
    }

    /// Injecting the fetch operation keeps parsing and event submission fully
    /// deterministic in tests without weakening the production fetch path.
    pub fn poll_once_with<C, F>(
        &self,
        engine: &Engine<C>,
        created_by: &str,
        fetch: F,
    ) -> Result<Vec<EventSubmitOutcome>>
    where
        C: Clock,
        F: FnOnce(&str) -> Result<String>,
    {
        let body = fetch(TOP_STORIES_URL)?;
        let story_ids: Vec<u64> =
            serde_json::from_str(&body).context("parse HN top stories response")?;

        story_ids
            .into_iter()
            .take(self.story_limit)
            .map(|id| {
                engine.submit_event(
                    self.spec.clone(),
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
