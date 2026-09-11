//! Inert output selectors. Values remain JSON, never executable expressions.
use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::{RunSpec, SpecError};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct OutputBinding {
    pub step: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub path: Option<Vec<InputSegment>>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum InputSegment {
    Key(String),
    Index(usize),
}

pub type InputBindings = BTreeMap<String, OutputBinding>;

pub fn validate_shape(input: &Value) -> Result<(), SpecError> {
    let malformed = || {
        SpecError::Malformed("input: expected a map of { step, path? } selectors; path must be an array when present".into())
    };
    let Some(bindings) = input.as_object() else {
        return Err(malformed());
    };
    for binding in bindings.values() {
        if !binding.is_object() || binding.get("path").is_some_and(|path| !path.is_array()) {
            return Err(malformed());
        }
    }
    Ok(())
}

pub fn validate_inputs(spec: &RunSpec) -> Result<(), SpecError> {
    for (index, step) in spec.steps.iter().enumerate() {
        for (name, binding) in step.input.iter().flatten() {
            let fail = |detail| {
                SpecError::Malformed(format!("step {:?} input {name:?}: {detail}", step.id))
            };
            if name.trim().is_empty() {
                return Err(fail("input name must not be empty".into()));
            }
            let Some(source) = spec.steps[..index]
                .iter()
                .find(|source| source.id == binding.step)
            else {
                return Err(fail(format!(
                    "source {:?} must name an earlier step; forward and self references are not supported",
                    binding.step
                )));
            };
            if !step.depends_on.contains(&binding.step) {
                return Err(fail(format!(
                    "source {:?} must be included in depends_on",
                    binding.step
                )));
            }
            let Some(schema) = &source.verification.json_schema else {
                return Err(fail(format!(
                    "source {:?} must declare an output schema",
                    binding.step
                )));
            };
            if !declares_path(schema, binding.path.as_deref().unwrap_or_default()) {
                return Err(fail(format!(
                    "path {:?} is not present in source {:?}'s declared output schema",
                    binding.path, binding.step
                )));
            }
        }
    }
    Ok(())
}

fn declares_path(schema: &Value, path: &[InputSegment]) -> bool {
    let mut current = schema;
    for segment in path {
        let next = match segment {
            InputSegment::Key(key) => current
                .get("properties")
                .and_then(|properties| properties.as_object())
                .and_then(|properties| properties.get(key)),
            InputSegment::Index(index) if *index <= 9_007_199_254_740_991 => {
                if let Some(prefix) = current
                    .get("prefixItems")
                    .and_then(Value::as_array)
                    .and_then(|items| items.get(*index))
                {
                    Some(prefix)
                } else {
                    current.get("items").and_then(|items| match items {
                        Value::Array(items) => items.get(*index),
                        _ => Some(items),
                    })
                }
            }
            InputSegment::Index(_) => None,
        };
        let Some(next) = next else { return false };
        current = next;
    }
    current != &Value::Bool(false)
}

pub fn select<'a>(output: &'a Value, path: &[InputSegment]) -> Option<&'a Value> {
    path.iter()
        .try_fold(output, |value, segment| match segment {
            InputSegment::Key(key) => value.as_object()?.get(key),
            InputSegment::Index(index) => value.as_array()?.get(*index),
        })
}
