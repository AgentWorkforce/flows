use std::{path::Path, sync::Arc};

use serde_json::Value;

use super::{ProtocolHub, ProtocolResult, internal_error, to_value};
use crate::Engine;

pub(super) fn handle(
    data_dir: &Path,
    hub: &Arc<ProtocolHub>,
    engine: &Engine,
    run_id: &str,
) -> ProtocolResult<Value> {
    let registry = relayflowd_journal::Registry::open(data_dir.join("relayflowd.sqlite3"))
        .map_err(|error| internal_error(error.into()))?;
    if registry
        .lookup(run_id)
        .map_err(|error| internal_error(error.into()))?
        .is_none()
    {
        return Err(("run_not_found", format!("run {run_id} does not exist")));
    }

    // The same lock guards completion: whichever request acquires it first
    // becomes the one linear history represented by the journal.
    let lock = hub.run_lock(run_id);
    let _guard = lock.lock().expect("run lock");
    let outcome = engine
        .cancel(run_id, "protocol-v0")
        .map_err(internal_error)?;
    if outcome.completion_reason.is_some() {
        hub.finish_run(run_id);
    }
    to_value(outcome)
}
