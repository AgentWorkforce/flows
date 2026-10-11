//! The memory-posture gate (design §4.3.2 J1; wire §1.2 `posture`, §1.5).
//!
//! Yama scope alone is insufficient (CAP_SYS_PTRACE bypasses it; scope 1
//! honours PR_SET_PTRACER), so a binding needs BOTH a host attestation that
//! reports a supported posture AND agreeing local readings. Unknown is
//! refused, never inferred. Linux only: elsewhere every binding is refused.

use serde_json::Value;

use super::Refusal;

const SCHEMA: &str = "relayflow-host-posture-v1";
/// Bit 19 of the capability masks in /proc/<pid>/status.
const CAP_SYS_PTRACE: u64 = 1 << 19;

/// A host attestation that passed every rule. Its fields are the readings the
/// local checks must agree with.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Attestation {
    pub yama_ptrace_scope: i64,
}

impl Attestation {
    pub fn parse(value: Option<&Value>) -> Result<Self, Refusal> {
        let refuse = |field: &str| Refusal::new("posture_unsupported", format!("posture.{field}"));
        let Some(Value::Object(posture)) = value else {
            return Err(Refusal::new("posture_unsupported", "posture"));
        };
        for key in posture.keys() {
            if !matches!(
                key.as_str(),
                "schema"
                    | "yamaPtraceScope"
                    | "cliNoNewPrivs"
                    | "daemonNoNewPrivs"
                    | "sudoEscalation"
                    | "sharedUserNamespace"
                    | "observedAt"
            ) {
                return Err(refuse(key));
            }
        }
        if posture.get("schema").and_then(Value::as_str) != Some(SCHEMA) {
            return Err(refuse("schema"));
        }
        let yama = posture
            .get("yamaPtraceScope")
            .and_then(Value::as_i64)
            .filter(|scope| *scope >= 1)
            .ok_or_else(|| refuse("yamaPtraceScope"))?;
        for flag in ["cliNoNewPrivs", "daemonNoNewPrivs"] {
            if posture.get(flag) != Some(&Value::Bool(true)) {
                return Err(refuse(flag));
            }
        }
        if posture.get("sudoEscalation").and_then(Value::as_str) != Some("absent") {
            return Err(refuse("sudoEscalation"));
        }
        if posture.get("sharedUserNamespace") != Some(&Value::Bool(false)) {
            return Err(refuse("sharedUserNamespace"));
        }
        if !posture.get("observedAt").is_some_and(Value::is_string) {
            return Err(refuse("observedAt"));
        }
        Ok(Self {
            yama_ptrace_scope: yama,
        })
    }
}

/// This process's own posture.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct LocalReadings {
    pub yama_ptrace_scope: Option<i64>,
    pub cap_sys_ptrace: bool,
    pub no_new_privs: bool,
}

impl LocalReadings {
    #[cfg(target_os = "linux")]
    pub fn read() -> Result<Self, Refusal> {
        let yama = std::fs::read_to_string("/proc/sys/kernel/yama/ptrace_scope")
            .ok()
            .and_then(|text| text.trim().parse().ok());
        let status = std::fs::read_to_string("/proc/self/status")
            .map_err(|_| Refusal::new("posture_unsupported", "local:status"))?;
        Ok(Self::from_status(yama, &status))
    }

    #[cfg(not(target_os = "linux"))]
    pub fn read() -> Result<Self, Refusal> {
        Err(Refusal::new("posture_unsupported", "local:platform"))
    }

    /// Parse `/proc/<pid>/status`. A missing or unparsable field reads as
    /// the unsafe value, so it is refused.
    pub fn from_status(yama_ptrace_scope: Option<i64>, status: &str) -> Self {
        let field = |name: &str| {
            status
                .lines()
                .find_map(|line| line.strip_prefix(name)?.strip_prefix(':'))
                .map(str::trim)
        };
        let cap_sys_ptrace = ["CapEff", "CapPrm", "CapAmb", "CapBnd"].iter().any(|name| {
            field(name)
                .and_then(|hex| u64::from_str_radix(hex, 16).ok())
                .is_none_or(|mask| mask & CAP_SYS_PTRACE != 0)
        });
        Self {
            yama_ptrace_scope,
            cap_sys_ptrace,
            no_new_privs: field("NoNewPrivs") == Some("1"),
        }
    }

    /// Refuse unless the local readings are safe AND agree with the attestation.
    pub fn check(&self, attestation: &Attestation) -> Result<(), Refusal> {
        let refuse = |check: &str| Refusal::new("posture_unsupported", format!("local:{check}"));
        match self.yama_ptrace_scope {
            Some(scope) if scope >= 1 && scope == attestation.yama_ptrace_scope => {}
            _ => return Err(refuse("yama")),
        }
        if self.cap_sys_ptrace {
            return Err(refuse("cap_sys_ptrace"));
        }
        if !self.no_new_privs {
            return Err(refuse("no_new_privs"));
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn posture() -> Value {
        json!({"schema": SCHEMA, "yamaPtraceScope": 1, "cliNoNewPrivs": true,
               "daemonNoNewPrivs": true, "sudoEscalation": "absent",
               "sharedUserNamespace": false, "observedAt": "2026-10-11T00:00:00Z"})
    }

    #[test]
    fn only_a_fully_supported_attestation_passes() {
        assert_eq!(
            Attestation::parse(Some(&posture()))
                .unwrap()
                .yama_ptrace_scope,
            1
        );
        assert_eq!(Attestation::parse(None).unwrap_err().field, "posture");
        for (key, bad) in [
            ("schema", json!("v0")),
            ("yamaPtraceScope", json!(0)),
            ("yamaPtraceScope", Value::Null),
            ("cliNoNewPrivs", json!(false)),
            ("daemonNoNewPrivs", Value::Null),
            ("sudoEscalation", json!("present")),
            ("sudoEscalation", json!("unknown")),
            ("sharedUserNamespace", json!(true)),
            ("sharedUserNamespace", Value::Null),
            ("observedAt", Value::Null),
        ] {
            let mut value = posture();
            value[key] = bad.clone();
            let refused = Attestation::parse(Some(&value)).unwrap_err();
            assert_eq!(
                (refused.code, refused.field.as_str()),
                ("posture_unsupported", format!("posture.{key}").as_str()),
                "{key}={bad}"
            );
        }
    }

    const SAFE: &str = "Name:\tx\nNoNewPrivs:\t1\nCapPrm:\t0000000000000000\nCapEff:\t0000000000000000\nCapBnd:\t0000000000000000\nCapAmb:\t0000000000000000\n";

    #[test]
    fn local_readings_must_be_safe_and_agree_with_the_attestation() {
        let attested = Attestation {
            yama_ptrace_scope: 1,
        };
        assert!(
            LocalReadings::from_status(Some(1), SAFE)
                .check(&attested)
                .is_ok()
        );
        let cases = [
            (LocalReadings::from_status(None, SAFE), "local:yama"),
            (LocalReadings::from_status(Some(0), SAFE), "local:yama"),
            (LocalReadings::from_status(Some(2), SAFE), "local:yama"),
            (
                LocalReadings::from_status(
                    Some(1),
                    &SAFE.replace("CapBnd:\t0000000000000000", "CapBnd:\t0000000000080000"),
                ),
                "local:cap_sys_ptrace",
            ),
            (
                LocalReadings::from_status(
                    Some(1),
                    &SAFE.replace("CapAmb:\t0000000000000000\n", ""),
                ),
                "local:cap_sys_ptrace",
            ),
            (
                LocalReadings::from_status(
                    Some(1),
                    &SAFE.replace("NoNewPrivs:\t1", "NoNewPrivs:\t0"),
                ),
                "local:no_new_privs",
            ),
        ];
        for (readings, field) in cases {
            assert_eq!(
                readings.check(&attested).unwrap_err().field,
                field,
                "{readings:?}"
            );
        }
    }
}
