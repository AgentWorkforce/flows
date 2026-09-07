//! Internal journal protocol only; no authoring schema additions.
use relayflowd_core::channel::{ChannelActor, ChannelCommand};
use serde::Deserialize;
use serde_json::Value;

use super::{Engine, ProtocolHub, protocol::*};
use crate::engine::ChannelCommandError;
use relayflowd_journal::JournalStoreError;

enum ChannelVerb {
    Append,
    Receive,
    Ack,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Params {
    run_id: String,
    step_id: String,
    attempt: u32,
    idempotency_key: String,
    channel: String,
    message_id: Option<String>,
    #[serde(default)]
    message: Value,
    delivery_seq: Option<i64>,
}

pub(super) fn handle(
    engine: &Engine,
    hub: &ProtocolHub,
    connection_id: u64,
    verb: &str,
    mut params: Value,
) -> ProtocolResult<Value> {
    let verb = match verb {
        "channel.append" => ChannelVerb::Append,
        "channel.receive" => ChannelVerb::Receive,
        "channel.ack" => ChannelVerb::Ack,
        _ => {
            return Err((
                "unsupported_verb",
                format!("unknown journal protocol verb {verb}"),
            ));
        }
    };
    let object = params
        .as_object_mut()
        .ok_or(("bad_request", "channel params must be an object".into()))?;
    let extra = match verb {
        ChannelVerb::Append => &["message_id", "message"][..],
        ChannelVerb::Ack => &["delivery_seq"][..],
        ChannelVerb::Receive => &[],
    };
    for field in object.keys() {
        if !["run_id", "step_id", "attempt", "idempotency_key", "channel"].contains(&field.as_str())
            && !extra.contains(&field.as_str())
        {
            return Err((
                "bad_request",
                format!("unexpected channel parameter {field}"),
            ));
        }
    }
    for field in extra {
        if !object.contains_key(*field) {
            return Err(("bad_request", format!("missing channel parameter {field}")));
        }
    }
    let p: Params = decode_params(params)?;
    let actor = ChannelActor {
        run_id: p.run_id,
        step_id: p.step_id,
        attempt: p.attempt,
        idempotency_key: p.idempotency_key,
    };
    let command = match verb {
        ChannelVerb::Append => ChannelCommand::Append {
            message_id: p
                .message_id
                .ok_or(("bad_request", "message_id must be a string".into()))?,
            message: p.message,
        },
        ChannelVerb::Ack => ChannelCommand::Acknowledge {
            delivery_seq: p
                .delivery_seq
                .ok_or(("bad_request", "delivery_seq must be an integer".into()))?,
        },
        ChannelVerb::Receive => ChannelCommand::Receive,
    };
    let lock = hub.run_lock(&actor.run_id);
    let _guard = lock.lock().expect("run lock");
    ensure_mutable(engine, &actor.run_id)?;
    hub.completion_worker(
        connection_id,
        &(actor.run_id.clone(), actor.step_id.clone(), actor.attempt),
    )
    .map_err(protocol_conflict)?;
    let entry = engine
        .channel_command(&actor, &p.channel, command)
        .map_err(|error| match error {
            ChannelCommandError::Journal(JournalStoreError::Channel(error)) => {
                ("channel_conflict", error.to_string())
            }
            ChannelCommandError::Journal(error) => internal_error(error.into()),
            ChannelCommandError::OpenRun(error) => internal_error(error),
        })?;
    to_value(entry)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn unknown_verb_never_falls_through_to_receive() {
        let directory = tempfile::tempdir().unwrap();
        let engine = Engine::new(directory.path());
        let hub = ProtocolHub::default();
        let error = handle(&engine, &hub, 1, "channel.future", Value::Null).unwrap_err();
        assert_eq!(
            error,
            (
                "unsupported_verb",
                "unknown journal protocol verb channel.future".to_owned()
            )
        );
    }
}
