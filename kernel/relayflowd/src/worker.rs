use anyhow::Result;
use relayflowd_core::{JournalEntry, Pins, RecoveryInstruction, StepSpec, StepType};
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
    #[serde(skip_serializing_if = "Option::is_none")]
    pub recovery: Option<RecoveryInstruction>,
    pub lease_deadline_ms: i64,
}

/// What became of one dispatch attempt. Every answer is a declared outcome the
/// caller journals or acts on — a dispatch never fails silently.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum DispatchOutcome {
    /// The lease is with a worker that holds the attempt's starting state.
    Dispatched,
    /// No attached worker takes this step class, or none reports the surfaces
    /// the attempt is pinned to. The run parks until one attaches.
    NoWorker,
    /// A worker takes the class and reports every pinned surface, but at
    /// different revisions/offsets than the attempt was elected against — the
    /// pin source detached and this is its replacement. Dispatching would hand
    /// it a starting state it is not in, so the attempt fails closed instead
    /// (Appendix A rule 2) and the step is re-elected from what a worker
    /// actually holds.
    PinMismatch { detail: String },
}

/// The binary owns scheduling; transports only deliver its durable leases.
pub trait StepDispatcher: Send + Sync {
    fn executor(&self, step_type: StepType) -> Option<String>;

    fn available(&self, step_type: StepType) -> bool;

    /// Opaque starting revisions/offsets reported by the selected worker for
    /// the first agent attempt. Later attempts are derived from the journal.
    fn starting_pins(&self, _step: &StepSpec) -> Result<Pins> {
        Ok(Pins::default())
    }

    fn dispatch(&self, dispatch: StepDispatch) -> Result<DispatchOutcome>;
}

/// Journal watches are projections. Notification happens only after append.
pub trait JournalObserver: Send + Sync {
    fn appended(&self, entry: &JournalEntry);
}

/// Answers whether a leased attempt still has a live worker behind it: the
/// connection is attached and its (heartbeat-renewed) lease deadline has not
/// passed. A live resume must not presume such attempts dead.
pub trait LeaseProbe: Send + Sync {
    fn lease_active(&self, run_id: &str, step_id: &str, attempt: u32, now_ms: i64) -> bool;
}
