//! Slice-1 provider seam. The default returns a fixed synthetic pack/cost;
//! no retrieval, relayhistory integration, or quality claim is implemented.
use anyhow::Result;
use relayflowd_core::{Budget, MemorySpec};
use serde_json::{Value, json};

#[derive(Debug, Clone)]
pub struct MemoryPack {
    pub pack: Value,
    pub budget: Budget,
}

pub trait MemoryProvider: Send + Sync {
    fn name(&self) -> &str;
    fn provide(&self, run_id: &str, step_id: &str, request: &MemorySpec) -> Result<MemoryPack>;
}

pub struct FixedMemoryProvider;

impl MemoryProvider for FixedMemoryProvider {
    fn name(&self) -> &str {
        "fixed-slice-1"
    }

    fn provide(&self, _run_id: &str, _step_id: &str, _request: &MemorySpec) -> Result<MemoryPack> {
        Ok(MemoryPack {
            pack: json!({"text": "fixed memory pack", "citations": []}),
            budget: Budget {
                tokens_in: 7,
                tokens_out: 0,
                dollars: "0.002".into(),
            },
        })
    }
}
