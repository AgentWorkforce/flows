use anyhow::Result;
use relayflowd_core::{JournalEntry, Pins, StepSpec, StepType};
use serde::Serialize;

/// A durable attempt made available to an out-of-band worker.
#[derive(Debug, Clone, Serialize)]
pub struct StepDispatch {
    pub run_id: String,
    pub step_id: String,
    pub attempt: u32,
    pub step_type: StepType,
    pub spec: StepSpec,
    pub lease_id: String,
    pub idempotency_key: String,
    pub pins: Pins,
    pub lease_deadline_ms: i64,
}

/// The binary owns scheduling; transports only deliver its durable leases.
pub trait StepDispatcher: Send + Sync {
    fn executor(&self, step_type: StepType) -> Option<String>;

    fn available(&self, step_type: StepType) -> bool;

    /// Returns `false` when no compatible worker is attached.
    fn dispatch(&self, dispatch: StepDispatch) -> Result<bool>;
}

/// Journal watches are projections. Notification happens only after append.
pub trait JournalObserver: Send + Sync {
    fn appended(&self, entry: &JournalEntry);
}
