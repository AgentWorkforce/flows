//! Run specs — the composable unit (RFC-0001 settled decision #5), one dialect.
//!
//! This is the single spec shape at the SDK↔kernel boundary: snake_case keys,
//! semver `version`, flat v0 verification (`output_contains` / `json_schema`;
//! `exit_code == 0` is implicit for deterministic steps — kernel DESIGN.md §4).
//! The SDK compiler emits exactly this shape; parity is pinned bit-for-bit by
//! `tests/spec_parity.rs` against `testdata/hello-ladder.spec.canonical.json`.
//!
//! Parsing is fail-closed (AGENTS.md rule 4): [`RunSpec::parse`] rejects any
//! unknown field, so a misspelled `verification` key can never silently drop a
//! gate. Nested structs carry `deny_unknown_fields`; step objects (which use
//! `#[serde(flatten)]`, where serde cannot enforce it) are checked explicitly.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Serialize};
use serde_json::Value;
use thiserror::Error;

/// The spec schema version this kernel reads and writes (semver, RFC §7).
pub const SPEC_VERSION: &str = "0.1.0";

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct RunSpec {
    #[serde(default = "default_spec_version")]
    pub version: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub name: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Default CLI declaration for llm/agent steps. `flows check` resolves
    /// step → flow → project config. The kernel treats this as inert data;
    /// `run.start` does not invoke the surface preflight in gate 1.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub cli: Option<String>,
    /// Inert gate-1 declarations. Matching and dispatch belong to gate 2.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub triggers: Vec<TriggerSpec>,
    #[serde(default)]
    pub steps: Vec<StepSpec>,
    /// Budget envelope (RFC settled decision #10). Carried and journaled from
    /// gate 1; enforced when llm/agent dispatch lands — the deterministic rung
    /// spends zero tokens.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub budget: Option<BudgetSpec>,
}

fn default_spec_version() -> String {
    SPEC_VERSION.to_owned()
}

impl RunSpec {
    /// Fail-closed parse: reject unknown fields everywhere before
    /// deserializing. `#[serde(flatten)]` on [`StepSpec`] prevents serde-level
    /// `deny_unknown_fields` for step objects, so their key sets are checked
    /// here; every non-flattened struct denies unknown fields via serde.
    pub fn parse(value: &Value) -> Result<Self, SpecError> {
        reject_unknown_step_fields(value)?;
        serde_json::from_value(value.clone())
            .map_err(|error| SpecError::Malformed(error.to_string()))
    }

    pub fn validate(&self) -> Result<(), SpecError> {
        if self.version != SPEC_VERSION {
            return Err(SpecError::UnsupportedVersion(self.version.clone()));
        }

        if self.cli.as_ref().is_some_and(|cli| cli.trim().is_empty()) {
            return Err(SpecError::EmptyCli);
        }

        let mut trigger_ids = BTreeSet::new();
        for trigger in &self.triggers {
            if trigger.id.trim().is_empty() || trigger.executor.trim().is_empty() {
                return Err(SpecError::InvalidTrigger(trigger.id.clone()));
            }
            if !trigger_ids.insert(trigger.id.clone()) {
                return Err(SpecError::DuplicateTrigger(trigger.id.clone()));
            }
        }

        let mut ids = BTreeSet::new();
        for step in &self.steps {
            if step.id.trim().is_empty() {
                return Err(SpecError::EmptyStepId);
            }
            if !ids.insert(step.id.clone()) {
                return Err(SpecError::DuplicateStep(step.id.clone()));
            }
            if step.max_iterations == 0 {
                return Err(SpecError::ZeroIterations(step.id.clone()));
            }
            let cli = match &step.kind {
                StepKind::Llm { cli, .. } | StepKind::Agent { cli, .. } => cli,
                StepKind::Deterministic { .. } => &None,
            };
            if cli.as_ref().is_some_and(|value| value.trim().is_empty()) {
                return Err(SpecError::EmptyStepCli(step.id.clone()));
            }
            step.retry.validate(&step.id)?;
        }

        for step in &self.steps {
            for dependency in &step.depends_on {
                if dependency == &step.id {
                    return Err(SpecError::DependencyCycle(step.id.clone()));
                }
                if !ids.contains(dependency) {
                    return Err(SpecError::UnknownDependency {
                        step: step.id.clone(),
                        dependency: dependency.clone(),
                    });
                }
            }
        }

        let dependencies = self
            .steps
            .iter()
            .map(|step| (step.id.as_str(), step.depends_on.as_slice()))
            .collect::<BTreeMap<_, _>>();
        let mut visiting = BTreeSet::new();
        let mut visited = BTreeSet::new();
        for id in &ids {
            visit(id, &dependencies, &mut visiting, &mut visited)?;
        }
        Ok(())
    }

    pub fn step(&self, id: &str) -> Option<&StepSpec> {
        self.steps.iter().find(|step| step.id == id)
    }
}

const STEP_COMMON_FIELDS: &[&str] = &[
    "id",
    "type",
    "depends_on",
    "max_iterations",
    "retry",
    "verification",
];
const STEP_DETERMINISTIC_FIELDS: &[&str] = &["command", "timeout_ms"];
const STEP_LLM_FIELDS: &[&str] = &["prompt", "model", "cli"];
const STEP_AGENT_FIELDS: &[&str] = &[
    "instruction",
    "cli",
    "recovery_mode",
    "surfaces",
    "permissions",
];

fn reject_unknown_step_fields(value: &Value) -> Result<(), SpecError> {
    let Some(steps) = value.get("steps").and_then(Value::as_array) else {
        return Ok(()); // shape errors surface from serde with their own message
    };
    for (index, step) in steps.iter().enumerate() {
        let Some(object) = step.as_object() else {
            continue;
        };
        let kind_fields = match object.get("type").and_then(Value::as_str) {
            Some("deterministic") => STEP_DETERMINISTIC_FIELDS,
            Some("llm") => STEP_LLM_FIELDS,
            Some("agent") => STEP_AGENT_FIELDS,
            // Missing/unknown type is rejected by serde's tagged-enum error.
            _ => continue,
        };
        for key in object.keys() {
            if !STEP_COMMON_FIELDS.contains(&key.as_str()) && !kind_fields.contains(&key.as_str()) {
                return Err(SpecError::UnknownField {
                    at: format!("steps[{index}]"),
                    field: key.clone(),
                });
            }
        }
    }
    Ok(())
}

fn visit<'a>(
    id: &'a str,
    dependencies: &BTreeMap<&'a str, &'a [String]>,
    visiting: &mut BTreeSet<&'a str>,
    visited: &mut BTreeSet<&'a str>,
) -> Result<(), SpecError> {
    if visited.contains(id) {
        return Ok(());
    }
    if !visiting.insert(id) {
        return Err(SpecError::DependencyCycle(id.to_owned()));
    }
    for dependency in dependencies.get(id).copied().unwrap_or_default() {
        visit(dependency, dependencies, visiting, visited)?;
    }
    visiting.remove(id);
    visited.insert(id);
    Ok(())
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct StepSpec {
    pub id: String,
    #[serde(default)]
    pub depends_on: Vec<String>,
    #[serde(default = "default_max_iterations")]
    pub max_iterations: u32,
    #[serde(default)]
    pub retry: RetryPolicy,
    #[serde(default)]
    pub verification: VerificationSpec,
    #[serde(flatten)]
    pub kind: StepKind,
}

fn default_max_iterations() -> u32 {
    1
}

impl StepSpec {
    pub fn step_type(&self) -> StepType {
        match self.kind {
            StepKind::Deterministic { .. } => StepType::Deterministic,
            StepKind::Llm { .. } => StepType::Llm,
            StepKind::Agent { .. } => StepType::Agent,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "snake_case")]
pub enum StepKind {
    Deterministic {
        command: CommandSpec,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        timeout_ms: Option<u64>,
    },
    Llm {
        prompt: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        model: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cli: Option<String>,
    },
    Agent {
        instruction: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        cli: Option<String>,
        #[serde(default)]
        recovery_mode: RecoveryMode,
        /// Declared mutable surfaces (RFC Appendix A rule 1) — names only.
        /// Revision/offset *pins* are runtime facts journaled per attempt
        /// (Appendix A rule 2), never spec fields.
        #[serde(default, skip_serializing_if = "AgentSurfaces::is_empty")]
        surfaces: AgentSurfaces,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        permissions: Option<PermissionsSpec>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(untagged)]
pub enum CommandSpec {
    Shell(String),
    Argv(Vec<String>),
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum StepType {
    Deterministic,
    Llm,
    Agent,
}

#[derive(Debug, Clone, Copy, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum RecoveryMode {
    #[default]
    Reset,
    Inspect,
    Manual,
}

/// Declared state surfaces for an agent step (RFC Appendix A rule 1):
/// workspace mounts/worktrees, writable streams, and external writeback paths.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct AgentSurfaces {
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub workspace: Vec<WorkspaceSurface>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub streams: Vec<StreamSurface>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub external: Vec<String>,
}

impl AgentSurfaces {
    pub fn is_empty(&self) -> bool {
        self.workspace.is_empty() && self.streams.is_empty() && self.external.is_empty()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct WorkspaceSurface {
    pub surface: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct StreamSurface {
    pub stream: String,
}

/// Permission model for an agent step (gate 8). Carried as data in gate 1;
/// enforcement lands with agent dispatch.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct PermissionsSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file_globs: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub network_allowlist: Option<Vec<String>>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access_preset: Option<AccessPreset>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AccessPreset {
    Readonly,
    Readwrite,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct TriggerSpec {
    pub id: String,
    pub executor: String,
}

/// Budget envelope: tokens are integers; money is a decimal string, never a
/// float (kernel DESIGN.md §1).
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct BudgetSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens_in: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_tokens_out: Option<u64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub max_dollars: Option<String>,
}

/// v0 verification gates (kernel DESIGN.md §4): `exit_code == 0` is implicit
/// for deterministic steps; these two are optional and combinable. Unknown
/// keys are a parse error — verification is control flow, and a dropped gate
/// is a fail-open bug, not a default.
#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(deny_unknown_fields)]
pub struct VerificationSpec {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub output_contains: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub json_schema: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(deny_unknown_fields)]
pub struct RetryPolicy {
    #[serde(default = "default_initial_backoff_ms")]
    pub initial_backoff_ms: u64,
    #[serde(default = "default_max_backoff_ms")]
    pub max_backoff_ms: u64,
    #[serde(default = "default_multiplier")]
    pub multiplier: u32,
    #[serde(default = "default_jitter_percent")]
    pub jitter_percent: u8,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            initial_backoff_ms: default_initial_backoff_ms(),
            max_backoff_ms: default_max_backoff_ms(),
            multiplier: default_multiplier(),
            jitter_percent: default_jitter_percent(),
        }
    }
}

impl RetryPolicy {
    fn validate(&self, step_id: &str) -> Result<(), SpecError> {
        if self.multiplier == 0 || self.jitter_percent > 100 {
            return Err(SpecError::InvalidRetry(step_id.to_owned()));
        }
        if self.max_backoff_ms < self.initial_backoff_ms {
            return Err(SpecError::InvalidRetry(step_id.to_owned()));
        }
        Ok(())
    }
}

fn default_initial_backoff_ms() -> u64 {
    100
}

fn default_max_backoff_ms() -> u64 {
    60_000
}

fn default_multiplier() -> u32 {
    2
}

fn default_jitter_percent() -> u8 {
    20
}

#[derive(Debug, Error, PartialEq, Eq)]
pub enum SpecError {
    #[error("unsupported run spec version {0} (this kernel reads {SPEC_VERSION})")]
    UnsupportedVersion(String),
    #[error("unknown field \"{field}\" at {at} — refusing to guess (fail closed)")]
    UnknownField { at: String, field: String },
    #[error("malformed run spec: {0}")]
    Malformed(String),
    #[error("flow cli cannot be empty")]
    EmptyCli,
    #[error("trigger {0} must declare a non-empty id and executor")]
    InvalidTrigger(String),
    #[error("duplicate trigger id: {0}")]
    DuplicateTrigger(String),
    #[error("step id cannot be empty")]
    EmptyStepId,
    #[error("step {0} cli cannot be empty")]
    EmptyStepCli(String),
    #[error("duplicate step id: {0}")]
    DuplicateStep(String),
    #[error("step {0} must allow at least one iteration")]
    ZeroIterations(String),
    #[error("step {step} depends on unknown step {dependency}")]
    UnknownDependency { step: String, dependency: String },
    #[error("dependency cycle includes step {0}")]
    DependencyCycle(String),
    #[error("invalid retry policy for step {0}")]
    InvalidRetry(String),
}

#[cfg(test)]
mod tests;
