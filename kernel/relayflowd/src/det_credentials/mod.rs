//! Trusted deterministic-step credentials (docs/proposals/trusted-det-step-credentials.md,
//! wire contract in trusted-det-step-credentials-wire.md).
//!
//! The trusted host hands the daemon ONE stdin frame at start: daemon-only
//! credential values, the per-lifetime capability K, the root authority pin,
//! the names deterministic steps must never see, and a posture attestation.
//! Nothing here is `Serialize`, and every `Debug` prints names only: no value,
//! K or derived secret may reach a journal, a protocol frame or a log.

pub mod ack;
pub mod frame;
pub mod posture;

use std::{
    collections::{BTreeMap, BTreeSet},
    fmt,
};

/// A refusal of the frame or of a later operation. Names a field or a name,
/// never a value (wire §1.3).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Refusal {
    pub code: &'static str,
    pub field: String,
}

impl Refusal {
    pub fn new(code: &'static str, field: impl Into<String>) -> Self {
        Self {
            code,
            field: field.into(),
        }
    }
}

impl fmt::Display for Refusal {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}: {}", self.code, self.field)
    }
}

/// A daemon-only credential value. Opaque to everything but injection.
#[derive(Clone, PartialEq, Eq)]
pub struct Secret(String);

impl Secret {
    pub(crate) fn new(value: String) -> Self {
        Self(value)
    }

    pub fn expose(&self) -> &str {
        &self.0
    }
}

impl fmt::Debug for Secret {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("Secret(redacted)")
    }
}

/// K: 32 bytes the host minted for this daemon lifetime.
#[derive(Clone, PartialEq, Eq)]
pub struct Capability([u8; 32]);

impl Capability {
    pub(crate) fn new(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn bytes(&self) -> &[u8; 32] {
        &self.0
    }
}

impl fmt::Debug for Capability {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str("K(redacted)")
    }
}

/// The root authority pin (design §4.3.1, wire §0/§1.2).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Pins {
    pub root_authority_sha256: String,
    pub display_fields: Vec<String>,
    pub root_admission_key: String,
}

/// Everything one frame binds for this daemon's lifetime.
#[derive(Clone, PartialEq, Eq)]
pub struct DetBinding {
    pub credentials: BTreeMap<String, Secret>,
    pub capability: Capability,
    pub pins: Pins,
    pub withhold: BTreeSet<String>,
}

/// What the host configured at start (wire §1.1): argv withhold names,
/// usable with no frame and no posture requirement, and optionally a frame.
#[derive(Debug)]
pub struct HostConfig {
    pub withhold: BTreeSet<String>,
    pub binding: Option<DetBinding>,
}

impl HostConfig {
    /// Names every deterministic step's base env loses: argv withhold ∪ frame
    /// withhold ∪ bound credential names. A frame can only add (wire §1.2).
    pub fn stripped_names(&self) -> BTreeSet<String> {
        let frame = self
            .binding
            .iter()
            .flat_map(|binding| binding.withhold.iter().chain(binding.credentials.keys()));
        self.withhold.iter().chain(frame).cloned().collect()
    }
}

impl fmt::Debug for DetBinding {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.debug_struct("DetBinding")
            .field("credentials", &self.credentials.keys().collect::<Vec<_>>())
            .field("capability", &self.capability)
            .field("pins", &self.pins)
            .field("withhold", &self.withhold)
            .finish()
    }
}

/// `relayflowd serve --det-frame-stdin --det-ack-fd <n>` (wire §1.1, §1.4).
/// Without the frame flag: no frame, no binding (today's behaviour). With
/// it, the frame is read from stdin and checked in the wire's precedence;
/// on refusal the refusal line goes to the ack fd (when usable) and stderr,
/// and the caller exits with [`ack::REFUSED_EXIT`].
pub fn bind_from_host(
    frame_stdin: bool,
    ack_fd: Option<i32>,
    withhold_arg: Option<&str>,
) -> Result<(HostConfig, Option<ack::AckFd>), Refusal> {
    let withhold = argv_withhold(withhold_arg)?;
    if !frame_stdin {
        return match ack_fd {
            Some(_) => Err(Refusal::new("ack_fd_invalid", "det-ack-fd")),
            None => Ok((
                HostConfig {
                    withhold,
                    binding: None,
                },
                None,
            )),
        };
    }
    let ack = ack::AckFd::adopt(ack_fd.unwrap_or(-1))?;
    let refuse = |ack: ack::AckFd, refusal: Refusal| {
        let _ = ack.refused(&refusal);
        Err(refusal)
    };
    let (binding, attestation) = match frame::read_frame(std::io::stdin().lock()) {
        Ok(read) => read,
        Err(refusal) => return refuse(ack, refusal),
    };
    if let Some(name) = binding
        .credentials
        .keys()
        .find(|name| withhold.contains(*name))
    {
        return refuse(ack, Refusal::new("name_conflict", name.clone()));
    }
    // A frame can never narrow the host's argv set (wire §1.2).
    if let Some(name) = withhold
        .iter()
        .find(|name| !binding.withhold.contains(*name))
    {
        return refuse(ack, Refusal::new("withhold_narrowed", name.clone()));
    }
    if let Err(refusal) = posture::LocalReadings::read().and_then(|local| local.check(&attestation))
    {
        return refuse(ack, refusal);
    }
    Ok((
        HostConfig {
            withhold,
            binding: Some(binding),
        },
        Some(ack),
    ))
}

/// `--det-withhold A,B,...` (PROPOSED decoupling, wire §1.1).
fn argv_withhold(arg: Option<&str>) -> Result<BTreeSet<String>, Refusal> {
    let mut names = BTreeSet::new();
    for name in arg.into_iter().flat_map(|arg| arg.split(',')) {
        if !valid_name(name) {
            return Err(Refusal::new("withhold_invalid", name));
        }
        if protected_name(name) {
            return Err(Refusal::new("name_protected", name));
        }
        names.insert(name.to_owned());
    }
    Ok(names)
}

/// `^[A-Z_][A-Z0-9_]*$` (wire §1.2).
pub(crate) fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_uppercase() || c == '_')
        && chars.all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || c == '_')
}

/// Names the kernel owns or the loader reads (design §4.1).
pub(crate) fn protected_name(name: &str) -> bool {
    matches!(name, "PATH" | "HOME" | "FLOWS_INPUT" | "RELAYFLOW_MEMORY")
        || name.starts_with("LD_")
        || name.starts_with("DYLD_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn debug_prints_names_never_values() {
        let binding = DetBinding {
            credentials: BTreeMap::from([(
                "GH_TOKEN".into(),
                Secret::new("ghs_value_1234".into()),
            )]),
            capability: Capability::new([7; 32]),
            pins: Pins {
                root_authority_sha256: "a".repeat(64),
                display_fields: vec![],
                root_admission_key: "authored-root:x".into(),
            },
            withhold: BTreeSet::from(["OPENAI_API_KEY".into()]),
        };
        let printed = format!("{binding:?}");
        assert!(
            printed.contains("GH_TOKEN") && printed.contains("K(redacted)"),
            "{printed}"
        );
        assert!(
            !printed.contains("ghs_value_1234") && !printed.contains("7, 7"),
            "{printed}"
        );
    }

    #[test]
    fn a_frame_only_adds_to_the_argv_withhold_set() {
        let config = HostConfig {
            withhold: argv_withhold(Some("ANTHROPIC_API_KEY,OPENAI_API_KEY")).unwrap(),
            binding: Some(DetBinding {
                credentials: BTreeMap::from([("GH_TOKEN".into(), Secret::new("x".repeat(9)))]),
                capability: Capability::new([0; 32]),
                pins: Pins {
                    root_authority_sha256: String::new(),
                    display_fields: vec![],
                    root_admission_key: String::new(),
                },
                withhold: BTreeSet::from(["XAI_API_KEY".into()]),
            }),
        };
        let names: Vec<_> = config.stripped_names().into_iter().collect();
        assert_eq!(
            names,
            [
                "ANTHROPIC_API_KEY",
                "GH_TOKEN",
                "OPENAI_API_KEY",
                "XAI_API_KEY"
            ]
        );
        assert_eq!(
            argv_withhold(Some("PATH")).unwrap_err().code,
            "name_protected"
        );
        assert_eq!(
            argv_withhold(Some("bad-name")).unwrap_err().code,
            "withhold_invalid"
        );
        assert!(argv_withhold(None).unwrap().is_empty());
    }

    #[test]
    fn names_follow_the_grammar_and_protect_loader_and_kernel_names() {
        assert!(valid_name("GH_TOKEN") && valid_name("_X1"));
        assert!(!valid_name("gh") && !valid_name("1X") && !valid_name("") && !valid_name("A-B"));
        for name in [
            "PATH",
            "HOME",
            "FLOWS_INPUT",
            "RELAYFLOW_MEMORY",
            "LD_PRELOAD",
            "DYLD_X",
        ] {
            assert!(protected_name(name), "{name}");
        }
        assert!(!protected_name("GH_TOKEN"));
    }
}
