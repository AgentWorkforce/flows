use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct Event {
    #[serde(rename = "type")]
    pub event_type: String,
    #[serde(default)]
    pub payload: Value,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub key: Option<String>,
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum EventError {
    #[error("event pattern must be a JSON object")]
    InvalidPattern,
    #[error("dedupe key template references unknown value {0}")]
    UnknownTemplateValue(String),
}

pub fn validate_pattern(pattern: &Value) -> Result<(), EventError> {
    if pattern.is_object() {
        Ok(())
    } else {
        Err(EventError::InvalidPattern)
    }
}

/// Object patterns are recursive subsets. Arrays and scalar leaves match exactly.
pub fn matches(pattern: &Value, payload: &Value) -> bool {
    match (pattern, payload) {
        (Value::Object(expected), Value::Object(actual)) => expected
            .iter()
            .all(|(key, value)| actual.get(key).is_some_and(|got| matches(value, got))),
        _ => pattern == payload,
    }
}

pub fn dedupe_key(template: &str, event: &Event) -> Result<String, EventError> {
    let mut output = template.replace("{{event.type}}", &event.event_type);
    while let Some(start) = output.find("{{payload.") {
        let rest = &output[start + 10..];
        let Some(end) = rest.find("}}") else {
            return Err(EventError::UnknownTemplateValue(output[start..].to_owned()));
        };
        let path = &rest[..end];
        let value = path
            .split('.')
            .try_fold(&event.payload, |value, part| value.get(part))
            .ok_or_else(|| EventError::UnknownTemplateValue(path.to_owned()))?;
        let rendered = value
            .as_str()
            .map(str::to_owned)
            .unwrap_or_else(|| value.to_string());
        output.replace_range(start..start + 10 + end + 2, &rendered);
    }
    if output.contains("{{") {
        return Err(EventError::UnknownTemplateValue(output));
    }
    Ok(output)
}
