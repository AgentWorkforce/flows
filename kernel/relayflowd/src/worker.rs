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
    /// The already journaled pack; workers must not charge its budget again.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub memory: Option<relayflowd_core::MemoryInjectedPayload>,
    pub lease_id: String,
    pub idempotency_key: String,
    pub pins: Pins,
    pub routing: relayflowd_core::RoutingDecision,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub wake_context: Option<serde_json::Value>,
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

    /// Reserve one worker slot before the durable start is appended. Runtime
    /// dispatchers override this atomically; stateless/in-process dispatchers
    /// retain the legacy availability behavior through this default.
    fn reserve_dispatch(
        &self,
        _run_id: &str,
        step: &StepSpec,
        _attempt: u32,
        _required_pins: &Pins,
    ) -> Result<bool> {
        Ok(self.available(step.step_type()))
    }

    /// Executor selected by [`reserve_dispatch`](Self::reserve_dispatch).
    fn reserved_executor(&self, _run_id: &str, step: &StepSpec, _attempt: u32) -> Option<String> {
        self.executor(step.step_type())
    }

    /// Supply starting pins for declared surfaces not yet covered by the journal.
    /// The default runs `git rev-parse --verify HEAD^{commit}` in each declared local
    /// worktree, using this process's filesystem, and fails on unreadable
    /// worktrees or declared streams (it cannot report stream offsets).
    /// Remote dispatchers must override this or `reserved_starting_pins` to
    /// report revisions/offsets from their selected worker instead of local Git.
    /// Surfaces already pinned by the run are carried forward from the journal.
    fn starting_pins(&self, step: &StepSpec) -> Result<Pins> {
        crate::workspace::starting_pins(step)
    }

    /// Starting pins for the worker whose capacity was reserved. The default
    /// delegates to `starting_pins`, including its local filesystem/Git behavior;
    /// remote dispatchers override this when pin lookup depends on the reservation.
    fn reserved_starting_pins(
        &self,
        _run_id: &str,
        step: &StepSpec,
        _attempt: u32,
    ) -> Result<Pins> {
        self.starting_pins(step)
    }

    /// Release an admission that did not become a live assignment.
    fn release_dispatch_reservation(&self, _run_id: &str, _step_id: &str, _attempt: u32) {}

    /// Fixed attached-worker placement. Provider-backed adapters override this
    /// to report their existing orchestration decision; dispatch consumes the
    /// journaled decision, including on retry, without choosing again.
    fn routing_decision(
        &self,
        _run_id: &str,
        step: &StepSpec,
        _attempt: u32,
    ) -> Result<relayflowd_core::RoutingDecision> {
        if step
            .requirements
            .as_ref()
            .is_some_and(|r| r != &relayflowd_core::PlacementRequirements::default())
        {
            anyhow::bail!("worker dispatcher must match the declared placement requirements");
        }
        Ok(relayflowd_core::RoutingDecision {
            profile: "attached-worker".into(),
            provider: "worker".into(),
            fallbacks_attempted: vec![],
            workspace: None,
        })
    }

    fn dispatch(&self, dispatch: StepDispatch) -> Result<DispatchOutcome>;

    /// Heartbeat-renewed operational deadline for one live assignment. The
    /// journal retains the original grant; a live server projection must use
    /// the assignment it currently owns instead of rewriting that history.
    fn active_lease_deadline(&self, _run_id: &str, _step_id: &str, _attempt: u32) -> Option<i64> {
        None
    }
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
