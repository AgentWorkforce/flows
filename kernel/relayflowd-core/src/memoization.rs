//! Cross-run memoization explicitly reuses durable successful facts.
use crate::{
    Action, Budget, CompletionReason, Disposition, EntryType, JournalEntry, RunState,
    StepCompletedPayload, StepSpec,
};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct ReusedFrom {
    pub run_id: String,
    pub step_id: String,
    pub seq: i64,
}

/// Match SDK UTF-16 key ordering and ECMAScript number spelling, including
/// the cases where serde_json's default serialization differs.
pub fn canonicalize(value: &Value) -> String {
    match value {
        Value::Object(object) => {
            let mut keys = object.keys().collect::<Vec<_>>();
            keys.sort_by(|a, b| a.encode_utf16().cmp(b.encode_utf16()));
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).expect("JSON key"),
                        canonicalize(&object[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(array) => format!(
            "[{}]",
            array.iter().map(canonicalize).collect::<Vec<_>>().join(",")
        ),
        // Preserve exact kernel integers; converting a u64 through f64 can
        // collapse distinct input values above JavaScript's safe-integer range.
        Value::Number(number) if number.is_i64() || number.is_u64() => number.to_string(),
        Value::Number(number) => ryu_js::Buffer::new()
            .format(number.as_f64().expect("JSON number"))
            .to_owned(),
        _ => serde_json::to_string(value).expect("JSON value"),
    }
}
pub fn canonical_hash(value: &Value) -> String {
    format!("{:x}", Sha256::digest(canonicalize(value).as_bytes()))
}
pub fn step_spec_hash(step: &StepSpec) -> String {
    canonical_hash(&serde_json::to_value(step).expect("serializable step"))
}

/// Actual selected values, not selectors or the prior run's input hash.
/// Missing selectors cause a miss; execution journals the typed input failure.
pub fn resolved_input(state: &RunState, step: &StepSpec) -> Option<Value> {
    let mut values = Map::new();
    for (name, binding) in step.input.iter().flatten() {
        let output = state.memo.get(&binding.step)?;
        let value = crate::input::select(output, binding.path.as_deref().unwrap_or_default())?;
        values.insert(name.clone(), value.clone());
    }
    Some(Value::Object(values))
}

/// Legacy entries without hashes and failed attempts are never eligible.
pub fn candidates(entries: &[JournalEntry]) -> Result<Vec<JournalEntry>, serde_json::Error> {
    let mut candidates = Vec::new();
    for entry in entries
        .iter()
        .filter(|e| e.entry_type == EntryType::StepCompleted)
    {
        let payload: StepCompletedPayload = serde_json::from_value(entry.payload.clone())?;
        if !payload.human_intervention
            && payload.completion_reason == CompletionReason::Success
            && payload.disposition == Disposition::StepDone
            && payload.step_spec_hash.is_some()
            && payload.input_hash.is_some()
            && entry.step_id.is_some()
        {
            candidates.push(entry.clone());
        }
    }
    Ok(candidates)
}

/// Preserve scheduler order, dependencies, surface exclusion, cancellation and
/// failure handling. Replace only fresh start/execution pairs.
pub fn next_actions_with_reuse(
    state: &RunState,
    source: &[JournalEntry],
    now_ms: i64,
) -> Vec<Action> {
    if source.is_empty() {
        return crate::next_actions(state, now_ms);
    }
    let mut result = Vec::new();
    let mut actions = crate::next_actions(state, now_ms).into_iter();
    while let Some(action) = actions.next() {
        if let Action::Append(start) = &action {
            if start.entry_type == EntryType::StepAttemptStarted && start.attempt == Some(1) {
                let step = state
                    .spec
                    .step(start.step_id.as_deref().expect("start step"))
                    .expect("scheduled step");
                if let Some(input) = resolved_input(state, step) {
                    let spec_hash = step_spec_hash(step);
                    let input_hash = canonical_hash(&input);
                    if let Some(prior) = source.iter().rev().find(|entry| {
                        entry.payload["step_spec_hash"].as_str() == Some(&spec_hash)
                            && entry.payload["input_hash"].as_str() == Some(&input_hash)
                    }) {
                        let mut payload: StepCompletedPayload =
                            serde_json::from_value(prior.payload.clone())
                                .expect("validated reuse snapshot");
                        payload.reused_from = Some(ReusedFrom {
                            run_id: prior.run_id.clone(),
                            step_id: prior.step_id.clone().expect("source step"),
                            seq: prior.seq,
                        });
                        payload.budget = Budget::default();
                        payload.completed_by = "kernel:reuse".into();
                        result.push(Action::Append(JournalEntry::new(
                            EntryType::StepCompleted,
                            &state.run_id,
                            Some(step.id.clone()),
                            Some(1),
                            now_ms,
                            payload,
                        )));
                        actions.next(); // adjacent execution action
                        continue;
                    }
                }
            }
        }
        result.push(action);
    }
    result
}
