//! The `--det-frame-stdin` frame (wire §1.2, §1.4). One JSON line of at most
//! 64 KiB, then EOF. Validation names the first failing field, never a value.

use std::{
    collections::{BTreeMap, BTreeSet},
    io::Read,
};

use serde_json::{Map, Value};

use super::{
    Capability, DetBinding, Pins, Refusal, Secret, posture::Attestation, protected_name, valid_name,
};

pub const MAX_FRAME_BYTES: usize = 65_536;
const MIN_VALUE_BYTES: usize = 8;
const MAX_VALUE_BYTES: usize = 32_768;

/// Read one frame: the line, then the rest of the stream to EOF.
pub fn read_frame(mut reader: impl Read) -> Result<(DetBinding, Attestation), Refusal> {
    let mut bytes = Vec::new();
    reader
        .by_ref()
        .take(MAX_FRAME_BYTES as u64 + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| Refusal::new("frame_missing", "frame"))?;
    let Some(end) = bytes.iter().position(|byte| *byte == b'\n') else {
        if bytes.len() > MAX_FRAME_BYTES {
            return Err(Refusal::new("frame_too_large", "frame"));
        }
        return Err(Refusal::new(
            if bytes.iter().all(u8::is_ascii_whitespace) {
                "frame_missing"
            } else {
                "frame_malformed"
            },
            "frame",
        ));
    };
    if end + 1 > MAX_FRAME_BYTES {
        return Err(Refusal::new("frame_too_large", "frame"));
    }
    let mut rest = bytes.split_off(end + 1);
    // Drain to EOF: the host closes stdin after the line.
    let mut sink = [0u8; 4096];
    loop {
        match reader.read(&mut sink) {
            Ok(0) => break,
            Ok(read) => {
                rest.extend_from_slice(&sink[..read]);
                if rest.len() > MAX_FRAME_BYTES {
                    break;
                }
            }
            Err(_) => break,
        }
    }
    if !rest.iter().all(u8::is_ascii_whitespace) {
        return Err(Refusal::new("frame_trailing_data", "frame"));
    }
    parse_frame(&bytes[..end])
}

pub fn parse_frame(line: &[u8]) -> Result<(DetBinding, Attestation), Refusal> {
    let value: Value =
        serde_json::from_slice(line).map_err(|_| Refusal::new("frame_malformed", "frame"))?;
    let Value::Object(frame) = value else {
        return Err(Refusal::new("frame_malformed", "frame"));
    };
    for key in frame.keys() {
        if !matches!(
            key.as_str(),
            "version" | "credentials" | "capability" | "pins" | "withhold" | "posture"
        ) {
            return Err(Refusal::new("frame_malformed", key.clone()));
        }
    }
    if frame.get("version") != Some(&Value::from(1)) {
        return Err(Refusal::new("version_unsupported", "version"));
    }
    let capability = capability(frame.get("capability"))?;
    let pins = pins(frame.get("pins"))?;
    let credentials = credentials(frame.get("credentials"))?;
    let withhold = withhold(frame.get("withhold"))?;
    if let Some(name) = credentials.keys().find(|name| withhold.contains(*name)) {
        return Err(Refusal::new("name_conflict", name.clone()));
    }
    let attestation = Attestation::parse(frame.get("posture"))?;
    Ok((
        DetBinding {
            credentials,
            capability,
            pins,
            withhold,
        },
        attestation,
    ))
}

fn lower_hex(value: &str, len: usize) -> bool {
    value.len() == len
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

fn capability(value: Option<&Value>) -> Result<Capability, Refusal> {
    let hex = value
        .and_then(Value::as_str)
        .filter(|hex| lower_hex(hex, 64))
        .ok_or_else(|| Refusal::new("capability_invalid", "capability"))?;
    let mut bytes = [0u8; 32];
    for (index, byte) in bytes.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[index * 2..index * 2 + 2], 16).expect("validated hex");
    }
    Ok(Capability::new(bytes))
}

fn pins(value: Option<&Value>) -> Result<Pins, Refusal> {
    let Some(Value::Object(pins)) = value else {
        return Err(Refusal::new("pin_missing", "pins"));
    };
    for key in pins.keys() {
        if !matches!(
            key.as_str(),
            "root_authority_sha256" | "display_fields" | "root_admission_key"
        ) {
            return Err(Refusal::new("pin_invalid", format!("pins.{key}")));
        }
    }
    let field = |name: &str| -> Result<&Value, Refusal> {
        pins.get(name)
            .ok_or_else(|| Refusal::new("pin_missing", format!("pins.{name}")))
    };
    let root_authority_sha256 = field("root_authority_sha256")?
        .as_str()
        .filter(|hex| lower_hex(hex, 64))
        .ok_or_else(|| Refusal::new("pin_invalid", "pins.root_authority_sha256"))?
        .to_owned();
    let root_admission_key = field("root_admission_key")?
        .as_str()
        .filter(|key| {
            key.strip_prefix("authored-root:")
                .is_some_and(|hash| lower_hex(hash, 64))
        })
        .ok_or_else(|| Refusal::new("pin_invalid", "pins.root_admission_key"))?
        .to_owned();
    let display_fields = field("display_fields")?
        .as_array()
        .and_then(|fields| {
            fields
                .iter()
                .map(|field| {
                    field
                        .as_str()
                        .filter(|p| p.starts_with('/'))
                        .map(str::to_owned)
                })
                .collect::<Option<Vec<_>>>()
        })
        .ok_or_else(|| Refusal::new("pin_invalid", "pins.display_fields"))?;
    Ok(Pins {
        root_authority_sha256,
        display_fields,
        root_admission_key,
    })
}

fn checked_name(name: &str, code: &'static str) -> Result<(), Refusal> {
    if !valid_name(name) {
        return Err(Refusal::new(code, name));
    }
    if protected_name(name) {
        return Err(Refusal::new("name_protected", name));
    }
    Ok(())
}

fn credentials(value: Option<&Value>) -> Result<BTreeMap<String, Secret>, Refusal> {
    let empty = Map::new();
    let map = match value {
        None => &empty,
        Some(Value::Object(map)) => map,
        Some(_) => return Err(Refusal::new("frame_malformed", "credentials")),
    };
    let mut credentials = BTreeMap::new();
    for (name, value) in map {
        checked_name(name, "credential_invalid")?;
        let secret = value
            .as_str()
            .filter(|value| {
                (MIN_VALUE_BYTES..=MAX_VALUE_BYTES).contains(&value.len()) && !value.contains('\0')
            })
            .ok_or_else(|| Refusal::new("credential_invalid", name.clone()))?;
        credentials.insert(name.clone(), Secret::new(secret.to_owned()));
    }
    Ok(credentials)
}

fn withhold(value: Option<&Value>) -> Result<BTreeSet<String>, Refusal> {
    let names = match value {
        None => return Ok(BTreeSet::new()),
        Some(Value::Array(names)) => names,
        Some(_) => return Err(Refusal::new("frame_malformed", "withhold")),
    };
    let mut withhold = BTreeSet::new();
    for name in names {
        let name = name
            .as_str()
            .ok_or_else(|| Refusal::new("frame_malformed", "withhold"))?;
        checked_name(name, "frame_malformed")?;
        withhold.insert(name.to_owned());
    }
    Ok(withhold)
}

#[cfg(test)]
#[path = "frame_tests.rs"]
mod tests;
