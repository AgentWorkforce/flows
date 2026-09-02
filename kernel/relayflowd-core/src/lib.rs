//! Pure Relayflow execution semantics.
//!
//! This crate deliberately contains no filesystem, process, network, SQLite,
//! or wall-clock access. Callers persist [`JournalEntry`] actions before
//! interpreting any execution action.

pub mod clock;
pub mod entry;
pub mod event;
pub mod journal;
pub mod machine;
pub mod retry;
mod schema;
pub mod spec;
pub mod state;
pub mod verify;

pub use clock::{Clock, SimClock};
pub use entry::*;
pub use event::{Event, EventError};
pub use journal::{Journal, JournalError, MemoryJournal};
pub use machine::{
    Action, AttemptResult, RecoveryInstruction, abandonment_actions, carried_pins_for,
    completion_actions, next_actions, recovery_actions, recovery_actions_filtered,
    request_cancel_action,
};
pub use spec::*;
pub use state::{RunState, StateError, StepRuntime, StepState};

pub const JOURNAL_VERSION: u32 = 1;
pub const PROTOCOL_VERSION: u32 = 0;
