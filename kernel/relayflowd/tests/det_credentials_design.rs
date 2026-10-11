//! DESIGN FIXTURE: trusted credentials for deterministic steps.
//!
//! Encodes the required behaviour of docs/proposals/trusted-det-step-credentials.md
//! (feature `det_credentials`). Two kinds of test live here:
//!
//! - `current_behaviour`: NOT ignored. A causal reproduction of today's Cloud
//!   shape on an unbound daemon: det steps lose the daemon-only credential and
//!   receive the CLI's agent-only keys. It passes on main because it pins the
//!   defect, and it keeps passing after the feature lands because nothing here
//!   changes the unbound path.
//! - every other module: the FUTURE contract, `#[ignore]`d with the reason.
//!   Forced with `--ignored` on a kernel without the feature, they all fail at
//!   the same first step -- `relayflowd serve` rejects the binding flags, or
//!   `hello` lacks `det_credentials`. That shows the interface is ABSENT. It
//!   is not one distinct security regression per test.
//!
//! The implementing PR removes the `#[ignore]` attributes and changes nothing
//! else; these tests are its gate. Once the feature exists, EACH security
//! guard must also get its own causal mutation run (revert that guard, capture
//! this fixture failing, restore it, capture the pass), per AGENTS.md
//! "Evidence is captured, not narrated". A green run here alone is not that.

#[path = "det_credentials_design/contract.rs"]
mod contract;
#[path = "det_credentials_design/current_behaviour.rs"]
mod current_behaviour;
#[path = "det_credentials_design/delegation.rs"]
mod delegation;
#[path = "det_credentials_design/entitlement.rs"]
mod entitlement;
#[path = "det_credentials_design/frame.rs"]
mod frame;
#[path = "det_credentials_design/harness.rs"]
mod harness;
#[path = "det_credentials_design/k_handling.rs"]
mod k_handling;
#[path = "det_credentials_design/leaks.rs"]
mod leaks;
#[path = "det_credentials_design/lifecycle.rs"]
mod lifecycle;
#[path = "det_credentials_design/ownership.rs"]
mod ownership;
#[path = "det_credentials_design/root_auth.rs"]
mod root_auth;
