use serde_json::Value;

use crate::{
    entry::{VerificationRecord, VerificationVerdict},
    spec::{StepKind, StepSpec},
};

pub fn verify(step: &StepSpec, output: &Value) -> VerificationRecord {
    let mut gates = Vec::new();
    let mut failures = Vec::new();

    if matches!(step.kind, StepKind::Deterministic { .. }) {
        gates.push("exit_code");
        match output.get("exit_code").and_then(Value::as_i64) {
            Some(0) => {}
            Some(code) => failures.push(format!("exit code was {code}")),
            None => failures.push("output omitted integer exit_code".to_owned()),
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
        detail: if passed {
            "all gates passed".to_owned()
        } else {
            failures.join("; ")
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
