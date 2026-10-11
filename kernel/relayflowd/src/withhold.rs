//! Names deterministic steps must never see (`relayflowd serve --det-withhold`).
//!
//! A trusted host (Cloud) puts agent-only credentials in the CLI's env so
//! agent steps can use them. Since per-run step environments (#655), a run's
//! `f.run` steps receive the CLI's env, and with it those agent keys. The host
//! passes their names here; the daemon strips them from EVERY deterministic
//! spawn -- whatever the run, whether its client sent an env or not, on every
//! attempt and after any restart started with the same flag -- and advertises
//! them in `hello` so a current SDK leaves their values off the wire too.
//!
//! Names only: no value ever reaches this module. A daemon started without
//! the flag behaves exactly as before.

use std::{collections::BTreeSet, fmt};

/// A refused `--det-withhold` argument. Names the offending name, never more.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct WithholdRefusal {
    pub code: &'static str,
    pub name: String,
}

impl fmt::Display for WithholdRefusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "--det-withhold refused: {}: {:?}", self.code, self.name)
    }
}

/// Exit status for a refused argument (EX_CONFIG).
pub const REFUSED_EXIT: i32 = 78;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Withhold(BTreeSet<String>);

impl Withhold {
    /// Parse `A,B,C`. Every name must match `^[A-Z_][A-Z0-9_]*$` and must not
    /// be protected. Duplicates are deduplicated. An empty list, or an empty
    /// entry, is refused: "no withholding" is expressed by omitting the flag.
    pub fn parse(arg: &str) -> Result<Self, WithholdRefusal> {
        let refuse = |code, name: &str| WithholdRefusal {
            code,
            name: name.to_owned(),
        };
        if arg.is_empty() {
            return Err(refuse("withhold_empty", ""));
        }
        let mut names = BTreeSet::new();
        for name in arg.split(',') {
            if !valid_name(name) {
                return Err(refuse("withhold_invalid", name));
            }
            if protected(name) {
                return Err(refuse("withhold_protected", name));
            }
            names.insert(name.to_owned());
        }
        Ok(Self(names))
    }

    pub fn names(&self) -> impl Iterator<Item = &str> {
        self.0.iter().map(String::as_str)
    }

    /// Refuse when the daemon's own environment holds a withheld name.
    ///
    /// Stripping at spawn hides a value from the step's env, but a step runs
    /// as the daemon's uid and could read the daemon's `/proc/<pid>/environ`.
    /// Removing the name in-process does not help: `unsetenv` never changes
    /// what `/proc/<pid>/environ` shows. The host controls this env and never
    /// needs a withheld value in it, so a daemon that holds one is
    /// misconfigured and fails closed instead of serving.
    pub fn refuse_if_held(
        &self,
        held: impl Fn(&str) -> bool,
    ) -> Result<(), WithholdRefusal> {
        match self.names().find(|name| held(name)) {
            Some(name) => Err(WithholdRefusal {
                code: "withhold_in_daemon_env",
                name: name.to_owned(),
            }),
            None => Ok(()),
        }
    }
}

/// Make this process non-dumpable (`PR_SET_DUMPABLE` 0), so processes of the
/// same uid -- every `f.run` step, which runs as the daemon's uid -- cannot
/// open its `/proc/<pid>/environ`, `mem` or `maps`. Those files become
/// root-owned and the kernel's ptrace-read check needs CAP_SYS_PTRACE.
/// Side effects: no core dump on a crash, and `/proc/<pid>` entries are
/// root-owned (`ps` still lists it; `cmdline` stays readable). The flag is
/// reset to the default for every exec'd child, so steps are unaffected.
#[cfg(target_os = "linux")]
pub fn make_non_dumpable() -> Result<(), WithholdRefusal> {
    // SAFETY: prctl(PR_SET_DUMPABLE) only changes this process's flag.
    if unsafe { libc::prctl(libc::PR_SET_DUMPABLE, 0, 0, 0, 0) } != 0 {
        return Err(WithholdRefusal {
            code: "withhold_not_dumpable_failed",
            name: String::new(),
        });
    }
    Ok(())
}

#[cfg(not(target_os = "linux"))]
pub fn make_non_dumpable() -> Result<(), WithholdRefusal> {
    // No /proc/<pid>/environ to protect on these platforms.
    Ok(())
}

fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_uppercase() || c == '_')
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// Names a step needs to run at all, the kernel sets itself, or the dynamic
/// loader reads. Withholding them would break steps or hide kernel inputs.
fn protected(name: &str) -> bool {
    matches!(
        name,
        "PATH" | "HOME" | "SHELL" | "USER" | "LOGNAME" | "TMPDIR" | "FLOWS_INPUT" | "RELAYFLOW_MEMORY"
    ) || name.starts_with("LD_")
        || name.starts_with("DYLD_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_dedupes_and_sorts() {
        let parsed = Withhold::parse("OPENAI_API_KEY,ANTHROPIC_API_KEY,OPENAI_API_KEY").unwrap();
        assert_eq!(
            parsed.names().collect::<Vec<_>>(),
            ["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]
        );
    }

    #[test]
    fn refuses_a_daemon_that_holds_a_withheld_value() {
        let withheld = Withhold::parse("ANTHROPIC_API_KEY,OPENAI_API_KEY").unwrap();
        assert!(withheld.refuse_if_held(|_| false).is_ok());
        let refusal = withheld
            .refuse_if_held(|name| name == "OPENAI_API_KEY")
            .unwrap_err();
        assert_eq!(
            (refusal.code, refusal.name.as_str()),
            ("withhold_in_daemon_env", "OPENAI_API_KEY")
        );
    }

    #[test]
    fn refuses_empty_malformed_and_protected_names() {
        let code = |arg: &str| Withhold::parse(arg).unwrap_err().code;
        assert_eq!(code(""), "withhold_empty");
        assert_eq!(code("A,,B"), "withhold_invalid");
        assert_eq!(code("A,"), "withhold_invalid");
        assert_eq!(code("openai_api_key"), "withhold_invalid");
        assert_eq!(code("1X"), "withhold_invalid");
        assert_eq!(code("A B"), "withhold_invalid");
        for name in [
            "PATH", "HOME", "SHELL", "USER", "LOGNAME", "TMPDIR", "FLOWS_INPUT",
            "RELAYFLOW_MEMORY", "LD_PRELOAD", "DYLD_INSERT_LIBRARIES",
        ] {
            assert_eq!(code(&format!("OK,{name}")), "withhold_protected", "{name}");
        }
        let refusal = Withhold::parse("GOOD,bad-name").unwrap_err();
        assert_eq!(refusal.name, "bad-name");
    }
}
