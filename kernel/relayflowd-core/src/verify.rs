use serde_json::Value;

use crate::{
    entry::{VerificationRecord, VerificationVerdict},
    spec::{OnNonZero, StepKind, StepSpec},
};

pub fn verify(step: &StepSpec, output: &Value) -> VerificationRecord {
    let mut gates = Vec::new();
    let mut failures = Vec::new();
    // Explanations that are not failures. A recorded red exit is a satisfied
    // policy, not a green command, and a reader is owed that distinction even
    // when a separate content or schema gate fails alongside it.
    let mut notes = Vec::new();

    if let StepKind::Deterministic { on_non_zero, .. } = &step.kind {
        match output.get("exit_code").and_then(Value::as_i64) {
            Some(0) => gates.push("exit_code"),
            // Only an ordinary POSITIVE code is the command's own verdict. The
            // executor writes -1 when the process produced no exit status at
            // all (killed by a signal, or never spawned); `record` must not
            // quietly absorb that, so it falls through to the fatal branch.
            Some(code) if code > 0 && *on_non_zero == OnNonZero::Record => {
                gates.push("exit_code:recorded");
                notes.push(format!("recorded exit code {code} (on_non_zero: record)"));
            }
            Some(code) => {
                gates.push("exit_code");
                failures.push(format!("exit code was {code}"));
            }
            None => {
                gates.push("exit_code");
                failures.push("output omitted integer exit_code".to_owned());
            }
        }
    }

    if let Some(needle) = &step.verification.output_contains {
        gates.push("output_contains");
        let haystack = output
            .as_str()
            .or_else(|| output.get("stdout_tail").and_then(Value::as_str))
            .map(str::to_owned)
            .unwrap_or_else(|| output.to_string());
        if !haystack.contains(needle) {
            failures.push(format!("output did not contain {needle:?}"));
        }
    }

    if let Some(schema) = &step.verification.json_schema {
        gates.push("json_schema");
        match crate::schema::compile(schema) {
            Ok(validator) => {
                if let Err(error) = validator.validate(output) {
                    failures.push(format!("JSON schema rejected output: {error}"));
                }
            }
            Err(error) => failures.push(format!("invalid JSON schema: {error}")),
        }
    }

    if gates.is_empty() {
        gates.push("completion");
    }
    let passed = failures.is_empty();
    VerificationRecord {
        gate: gates.join("+"),
        verdict: if passed {
            VerificationVerdict::Pass
        } else {
            VerificationVerdict::Fail
        },
        detail: match (passed, notes.is_empty()) {
            (true, true) => "all gates passed".to_owned(),
            (true, false) => notes.join("; "),
            // Notes first: why the step is complete-but-red is the context the
            // failures below are read in, and it must not be dropped.
            (false, _) => notes
                .into_iter()
                .chain(failures)
                .collect::<Vec<_>>()
                .join("; "),
        },
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn deterministic_output_requires_successful_exit_and_content() {
        let step: StepSpec = serde_json::from_value(json!({
            "id": "hello",
            "type": "deterministic",
            "command": "true",
            "verification": {"output_contains": "hello"}
        }))
        .unwrap();
        assert_eq!(
            verify(
                &step,
                &json!({"exit_code": 0, "stdout_tail": "hello world"})
            )
            .verdict,
            VerificationVerdict::Pass
        );
        assert_eq!(
            verify(
                &step,
                &json!({"exit_code": 1, "stdout_tail": "hello world"})
            )
            .verdict,
            VerificationVerdict::Fail
        );
    }

    /// A journal written by an older kernel can still hold an unbounded
    /// schema; `run.resume` does not re-validate the stored spec. Routing
    /// `verify` through the same declaration gate turns that into a gate
    /// failure with a verdict instead of a SIGABRT. Remove the bound and this
    /// test does not fail — it aborts the whole test binary.
    #[test]
    fn an_unbounded_schema_in_a_journal_fails_its_gate_instead_of_aborting() {
        let step: StepSpec = serde_json::from_value(json!({
            "id": "poisoned",
            "type": "deterministic",
            "command": "true",
            "verification": {
                "json_schema": {
                    "$defs": {"a": {"$ref": "#/$defs/b"}, "b": {"$ref": "#/$defs/a"}},
                    "$ref": "#/$defs/a"
                }
            }
        }))
        .unwrap();
        let record = verify(&step, &json!({"exit_code": 0, "stdout_tail": ""}));
        assert_eq!(record.verdict, VerificationVerdict::Fail);
        assert!(
            record.detail.contains("unbounded $ref cycle"),
            "{}",
            record.detail
        );
    }

    fn recording_step(verification: Value) -> StepSpec {
        serde_json::from_value(json!({
            "id": "tests",
            "type": "deterministic",
            "command": "npm test",
            "on_non_zero": "record",
            "verification": verification
        }))
        .unwrap()
    }

    /// Repair-before-failure: the command is allowed to be red. The verdict
    /// passes so dependents run, and the gate label and detail keep the code
    /// so a reader can never mistake this for a green command.
    #[test]
    fn a_recorded_nonzero_exit_passes_its_gate_and_names_the_code() {
        let step = recording_step(json!({}));
        let record = verify(&step, &json!({"exit_code": 7, "stdout_tail": "2 failing"}));
        assert_eq!(record.verdict, VerificationVerdict::Pass);
        assert_eq!(record.gate, "exit_code:recorded");
        assert!(record.detail.contains('7'), "{}", record.detail);

        // A green command under the same policy is still an ordinary pass.
        let green = verify(&step, &json!({"exit_code": 0, "stdout_tail": "ok"}));
        assert_eq!(green.verdict, VerificationVerdict::Pass);
        assert_eq!(green.gate, "exit_code");
        assert_eq!(green.detail, "all gates passed");
    }

    /// `record` is a policy for the exit code alone. A declared content or
    /// schema gate still fails the step — and the recorded code survives into
    /// the detail beside the failure rather than being displaced by it.
    #[test]
    fn recording_an_exit_code_does_not_relax_a_declared_content_gate() {
        let step = recording_step(json!({"output_contains": "PASS"}));
        let record = verify(&step, &json!({"exit_code": 7, "stdout_tail": "2 failing"}));
        assert_eq!(record.verdict, VerificationVerdict::Fail);
        assert_eq!(record.gate, "exit_code:recorded+output_contains");
        assert!(record.detail.contains('7'), "{}", record.detail);
        assert!(record.detail.contains("PASS"), "{}", record.detail);
    }

    /// A step that never produced an exit status has no verdict to record.
    /// `-1` is the executor's sentinel for "killed, or never ran"; absorbing
    /// it would let a timed-out command read as a recorded red test run.
    #[test]
    fn recording_does_not_absorb_a_missing_or_sentinel_exit_status() {
        let step = recording_step(json!({}));
        for output in [
            json!({"exit_code": -1, "stdout_tail": ""}),
            json!({"stdout_tail": ""}),
            json!({"exit_code": "7"}),
        ] {
            let record = verify(&step, &output);
            assert_eq!(record.verdict, VerificationVerdict::Fail, "{output}");
            assert_eq!(record.gate, "exit_code", "{output}");
        }
    }

    /// Without the declaration nothing moves: the default is still fatal.
    #[test]
    fn the_default_policy_still_fails_a_nonzero_exit() {
        let step: StepSpec = serde_json::from_value(json!({
            "id": "tests", "type": "deterministic", "command": "npm test"
        }))
        .unwrap();
        let record = verify(&step, &json!({"exit_code": 7, "stdout_tail": ""}));
        assert_eq!(record.verdict, VerificationVerdict::Fail);
        assert_eq!(record.gate, "exit_code");
    }

    #[test]
    fn json_schema_is_a_control_gate() {
        let step: StepSpec = serde_json::from_value(json!({
            "id": "model",
            "type": "llm",
            "prompt": "answer",
            "verification": {
                "json_schema": {"type": "object", "required": ["answer"]}
            }
        }))
        .unwrap();
        assert_eq!(
            verify(&step, &json!({"answer": 42})).verdict,
            VerificationVerdict::Pass
        );
        assert_eq!(verify(&step, &json!({})).verdict, VerificationVerdict::Fail);
    }
}
