//! Stateless admission check: identical to run.start (parse then validate).
//! This is intentionally stricter than event.submit, which currently only parses.
use relayflowd_core::{PROTOCOL_VERSION, RunSpec, spec::SPEC_VERSION};
use serde_json::{Value, json};

pub fn validate_spec(value: &Value) -> Value {
    let result = RunSpec::parse(value).and_then(|spec| spec.validate());
    match result {
        Ok(()) => json!({"ok": true, "protocol": PROTOCOL_VERSION, "spec_version": SPEC_VERSION}),
        Err(error) => refusal(error.to_string()),
    }
}

pub fn refusal(message: String) -> Value {
    json!({"ok": false, "protocol": PROTOCOL_VERSION, "spec_version": SPEC_VERSION,
        "error": {"code": "invalid_spec", "message": message}})
}
