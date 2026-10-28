//! A run's deterministic step environment, as the run's client supplied it.
//!
//! One daemon serves every `flows run` on a data dir, so the daemon's own
//! process environment belongs to whichever CLI started it. A client that
//! sends `env` on `run.start` / `run.resume` gets its `f.run` steps spawned
//! with exactly that environment instead (DAEMON-LIFECYCLE.md §3).
//!
//! The values are secrets by default. They live only in daemon memory: this
//! type is not `Serialize`, its `Debug` prints no values, and nothing here is
//! journaled, registered, or traced. A daemon restart therefore forgets them;
//! the next `run.resume` that carries `env` supplies them again.

use std::{collections::{BTreeMap, BTreeSet}, fmt};

use serde::Deserialize;

#[derive(Clone, Default, Deserialize, PartialEq, Eq)]
#[serde(transparent)]
pub struct StepEnv(BTreeMap<String, String>);

impl StepEnv {
    /// Refuse what the OS cannot spawn with. Names a key, never a value.
    pub fn validate(&self) -> Result<(), String> {
        for (key, value) in &self.0 {
            if key.is_empty() || key.contains(['=', '\0']) {
                return Err(format!("env key {key:?} is not a valid variable name"));
            }
            if value.contains('\0') {
                return Err(format!("env value for {key:?} contains a NUL byte"));
            }
        }
        Ok(())
    }

    pub fn vars(&self) -> impl Iterator<Item = (&str, &str)> {
        self.0
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
    }

    /// Select only this step's declared delivered secrets. Other ordinary
    /// variables remain available. The manifest and values never reach a
    /// deterministic child, and malformed metadata refuses the spawn.
    pub fn for_step(&self, grants: &[String]) -> Result<Self, String> {
        const MANIFEST: &str = "RELAY_SECRET_ENV_NAMES";
        let delivered: BTreeSet<String> = match self.0.get(MANIFEST) {
            Some(raw) => {
                let names: Vec<String> = serde_json::from_str(raw)
                    .map_err(|_| "secret name manifest is invalid".to_owned())?;
                let set: BTreeSet<String> = names.iter().cloned().collect();
                if set.len() != names.len() || names.iter().any(|name| name == MANIFEST || !self.0.contains_key(name)) {
                    return Err("secret name manifest contains duplicate, reserved or unavailable names".into());
                }
                set
            }
            None => BTreeSet::new(),
        };
        for name in grants {
            if !self.0.contains_key(name) || (self.0.contains_key(MANIFEST) && !delivered.contains(name)) {
                return Err(format!("step secret {name:?} is not available to this run"));
            }
        }
        Ok(Self(self.0.iter()
            .filter(|(name, _)| name.as_str() != MANIFEST && (!delivered.contains(*name) || grants.contains(name)))
            .map(|(name, value)| (name.clone(), value.clone())).collect()))
    }
}

impl From<BTreeMap<String, String>> for StepEnv {
    fn from(vars: BTreeMap<String, String>) -> Self {
        Self(vars)
    }
}

impl fmt::Debug for StepEnv {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "StepEnv({} vars, values redacted)", self.0.len())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn env(pairs: &[(&str, &str)]) -> StepEnv {
        pairs
            .iter()
            .map(|(k, v)| ((*k).to_owned(), (*v).to_owned()))
            .collect::<BTreeMap<_, _>>()
            .into()
    }

    #[test]
    fn debug_never_prints_values() {
        let printed = format!("{:?}", env(&[("TOKEN", "s3cret-value")]));
        assert!(!printed.contains("s3cret-value"), "{printed}");
        assert!(!printed.contains("TOKEN"), "{printed}");
    }

    #[test]
    fn validation_refuses_unspawnable_vars_without_echoing_values() {
        assert!(env(&[("OK", "fine")]).validate().is_ok());
        assert!(env(&[("", "x")]).validate().is_err());
        assert!(env(&[("A=B", "x")]).validate().is_err());
        let error = env(&[("K", "s3cret\0value")]).validate().unwrap_err();
        assert!(!error.contains("s3cret"), "{error}");
    }

    #[test]
    fn only_granted_delivered_secrets_enter_each_step() {
        let source = env(&[
            ("PATH", "/bin"),
            ("NATIVE_API_TOKEN", "native-secret"),
            ("OTHER_TOKEN", "other-secret"),
            ("RELAY_SECRET_ENV_NAMES", "[\"NATIVE_API_TOKEN\",\"OTHER_TOKEN\"]"),
        ]);
        let none = source.for_step(&[]).unwrap();
        assert_eq!(none.vars().collect::<Vec<_>>(), vec![("PATH", "/bin")]);
        let granted = source.for_step(&["NATIVE_API_TOKEN".to_owned()]).unwrap();
        assert_eq!(granted.vars().collect::<Vec<_>>(), vec![("NATIVE_API_TOKEN", "native-secret"), ("PATH", "/bin")]);
        let error = source.for_step(&["MISSING".to_owned()]).unwrap_err();
        assert!(!error.contains("native-secret"));
        let error = source.for_step(&["PATH".to_owned()]).unwrap_err();
        assert!(error.contains("PATH"));
        assert!(env(&[("RELAY_SECRET_ENV_NAMES", "{invalid")]).for_step(&[]).is_err());
    }
}
