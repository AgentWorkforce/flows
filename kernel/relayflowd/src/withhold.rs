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

    /// Whether this process's own environment holds any withheld name.
    pub fn held_by_this_process(&self) -> bool {
        self.names().any(|name| std::env::var_os(name).is_some())
    }

    /// `vars` without any withheld name.
    pub fn clean<K: AsRef<std::ffi::OsStr>, V>(
        &self,
        vars: impl IntoIterator<Item = (K, V)>,
    ) -> Vec<(K, V)> {
        vars.into_iter()
            .filter(|(name, _)| {
                !self
                    .0
                    .iter()
                    .any(|withheld| name.as_ref() == withheld.as_str())
            })
            .collect()
    }

    /// Replace this process with itself -- same executable, same argv --
    /// minus every withheld name in its environment, before it serves.
    ///
    /// A step runs as the daemon's uid and can read the daemon's
    /// `/proc/<pid>/environ`, which shows the environment the process was
    /// exec'd with: `unsetenv` never changes it. Only a fresh `execve` with a
    /// clean environment does. Returns only if the exec failed; the caller
    /// then refuses to start rather than serve while holding the values.
    #[cfg(target_os = "linux")]
    pub fn reexec_clean(&self) -> WithholdRefusal {
        use std::os::unix::process::CommandExt;
        let mut args = std::env::args_os();
        let mut command = std::process::Command::new("/proc/self/exe");
        if let Some(arg0) = args.next() {
            command.arg0(arg0);
        }
        let error = command
            .args(args)
            .env_clear()
            .envs(self.clean(std::env::vars_os()))
            .exec();
        WithholdRefusal {
            code: "withhold_reexec_failed",
            name: error.kind().to_string(),
        }
    }

    #[cfg(not(target_os = "linux"))]
    pub fn reexec_clean(&self) -> WithholdRefusal {
        WithholdRefusal {
            code: "withhold_in_daemon_env",
            name: String::new(),
        }
    }
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
        "PATH"
            | "HOME"
            | "SHELL"
            | "USER"
            | "LOGNAME"
            | "TMPDIR"
            | "FLOWS_INPUT"
            | "RELAYFLOW_MEMORY"
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
    fn clean_drops_exactly_the_withheld_names() {
        let withheld = Withhold::parse("ANTHROPIC_API_KEY,OPENAI_API_KEY").unwrap();
        let vars = [
            ("PATH", "/bin"),
            ("OPENAI_API_KEY", "x"),
            ("OPENAI_API_KEY_HINT", "y"),
            ("ANTHROPIC_API_KEY", "z"),
        ];
        assert_eq!(
            withheld.clean(vars),
            [("PATH", "/bin"), ("OPENAI_API_KEY_HINT", "y")]
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
            "PATH",
            "HOME",
            "SHELL",
            "USER",
            "LOGNAME",
            "TMPDIR",
            "FLOWS_INPUT",
            "RELAYFLOW_MEMORY",
            "LD_PRELOAD",
            "DYLD_INSERT_LIBRARIES",
        ] {
            assert_eq!(code(&format!("OK,{name}")), "withhold_protected", "{name}");
        }
        let refusal = Withhold::parse("GOOD,bad-name").unwrap_err();
        assert_eq!(refusal.name, "bad-name");
    }
}
