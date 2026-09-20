use std::{io::BufReader, sync::Arc, time::Duration};

use serde_json::json;
use tempfile::tempdir;

use super::super::super::*;
use super::super::{read_frame, request, shared_writer};

#[test]
fn required_streams_keep_ordinary_steps_off_conversation_workers() {
    let directory = tempdir().unwrap();
    let hub = Arc::new(ProtocolHub::default());
    let mut peers = Vec::new();
    // Register restricted workers first: without the eligibility condition the
    // ordinary first step steals a's only slot and a cannot start.
    for (connection, name, required) in [(1, "a", true), (2, "b", true), (3, "ordinary", false)] {
        let (writer, peer) = shared_writer();
        peer.set_read_timeout(Some(Duration::from_secs(2))).unwrap();
        let response = request(
            directory.path(),
            &hub,
            connection,
            &writer,
            &json!({"id":"attach","verb":"worker.attach","params":{
                "worker_id":name,"step_types":["agent"],
                "pins":{"streams":[{"stream":name,"read_offset":0}]},
                "required_streams": if required { vec![name] } else { vec![] }
            }})
            .to_string(),
        );
        assert!(response.ok, "attach: {:?}", response.error);
        peers.push((name, BufReader::new(peer)));
    }
    let (writer, _peer) = shared_writer();
    let response = request(directory.path(), &hub, 4, &writer,
        &json!({"id":"start","verb":"run.start","params":{"spec":{"steps":[
            {"id":"ordinary","type":"agent","instruction":"wait"},
            {"id":"a","type":"agent","instruction":"converse","surfaces":{"streams":[{"stream":"a"}]}},
            {"id":"b","type":"agent","instruction":"converse","surfaces":{"streams":[{"stream":"b"}]}}
        ]}}}).to_string());
    assert!(response.ok, "start: {:?}", response.error);
    for (name, mut peer) in peers {
        let frame = read_frame(&mut peer);
        assert_eq!(frame["event"], "step.dispatch");
        assert_eq!(frame["data"]["step_id"], name);
    }
}

#[test]
fn required_streams_must_be_held_before_worker_registration() {
    let directory = tempdir().unwrap();
    let hub = Arc::new(ProtocolHub::default());
    let (writer, _peer) = shared_writer();
    let response = request(
        directory.path(),
        &hub,
        1,
        &writer,
        &json!({"id":"attach","verb":"worker.attach","params":{
            "worker_id":"a","step_types":["agent"],
            "pins":{"streams":[{"stream":"held","read_offset":0}]},
            "required_streams":["not-held"]
        }})
        .to_string(),
    );
    assert!(!response.ok);
    assert_eq!(response.error.unwrap().code, "bad_request");
}
