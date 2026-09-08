//! Gate 7 declaration and durable decision. No provider or filesystem I/O.
use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PlacementRequirements {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub execution: Option<ExecutionMode>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub expected_duration_ms: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preference: Option<PlacementPreference>,
}

impl PlacementRequirements {
    pub fn validate(&self) -> Result<(), String> {
        if self
            .expected_duration_ms
            .is_some_and(|ms| ms == 0 || ms > 9_007_199_254_740_991)
        {
            return Err("requirements.expected_duration_ms must be a positive safe integer".into());
        }
        Ok(())
    }
}

pub fn validate_shape(value: &serde_json::Value) -> Result<(), String> {
    let object = value.as_object().ok_or("requirements must be an object")?;
    if object.values().any(serde_json::Value::is_null) {
        return Err("requirements fields cannot be null".into());
    }
    let requirements: PlacementRequirements =
        serde_json::from_value(value.clone()).map_err(|e| e.to_string())?;
    requirements.validate()
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ExecutionMode {
    Batch,
    Interactive,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PlacementPreference {
    Cost,
    Latency,
    Reliability,
    Balanced,
}

/// One fixed decision per step, retained on retry and replay. A provider adapter
/// consumes this fact; it must not rank providers again after the append.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct RoutingDecision {
    pub profile: String,
    pub provider: String,
    pub fallbacks_attempted: Vec<String>,
    /// Opaque provider workspace identity. Local execution uses a canonical cwd;
    /// cloud adapters can identify their existing per-run sandbox here.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub workspace: Option<String>,
}

impl RoutingDecision {
    /// Shared field validation for admission, replay, and epoch reconstruction.
    /// Return the rejected field so operational failures retain their cause.
    pub fn validate(&self) -> Result<(), String> {
        for (field, value) in [
            ("profile", self.profile.as_str()),
            ("provider", self.provider.as_str()),
        ] {
            if value.trim().is_empty() {
                return Err(format!("{field} must not be blank"));
            }
        }
        if self
            .workspace
            .as_ref()
            .is_some_and(|value| value.trim().is_empty())
        {
            return Err("workspace must not be blank".into());
        }
        for (index, value) in self.fallbacks_attempted.iter().enumerate() {
            if value.trim().is_empty() {
                return Err(format!("fallbacks_attempted[{index}] must not be blank"));
            }
        }
        Ok(())
    }
}
