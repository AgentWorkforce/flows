//! The host frame and its ack (wire §1). Real daemon process, real stdin and
//! a real ack pipe on fd 3.

use serde_json::json;

use super::{contract::*, harness::*};

#[test]
fn a_complete_frame_is_acked_and_the_withheld_names_are_published() {
    let fixture = Fixture::new();
    // Slice 1 needs no declaring step; any pinned root will do.
    let root = spec(vec![det("p", "true", &[])]);
    let daemon = Daemon::start(&fixture, Some(&cloud_binding(&root)), &[]);
    let ack = daemon.ack_line();
    assert!(ack.contains(r#""det_frame":"accepted""#), "{ack}");
    assert!(ack.contains(r#""credentials":["GH_TOKEN"]"#), "{ack}");
    assert!(
        !ack.contains(BOUND_VALUE) && !ack.contains(ROOT_SECRET),
        "{ack}"
    );
    let hello = hello(&mut fixture.connect());
    let withheld = hello["det_withheld"].as_array().unwrap();
    assert!(withheld.contains(&json!(BOUND)), "{hello}");
    for (name, _) in AGENT_ONLY {
        assert!(withheld.contains(&json!(name)), "{hello}");
    }
    assert!(!hello.to_string().contains(BOUND_VALUE), "{hello}");
}

#[test]
fn an_unsupported_posture_attestation_refuses_the_binding() {
    let fixture = Fixture::new();
    // Slice 1 needs no declaring step; any pinned root will do.
    let root = spec(vec![det("p", "true", &[])]);
    for (key, value) in [
        ("sudoEscalation", json!("present")),
        ("sudoEscalation", json!("unknown")),
        ("yamaPtraceScope", serde_json::Value::Null),
        ("sharedUserNamespace", json!(true)),
    ] {
        let mut posture = json!({
            "schema": "relayflow-host-posture-v1", "yamaPtraceScope": 1,
            "cliNoNewPrivs": true, "daemonNoNewPrivs": true, "sudoEscalation": "absent",
            "sharedUserNamespace": false, "observedAt": "2026-10-11T00:00:00Z",
        });
        posture[key] = value;
        let binding = Binding {
            posture: Some(posture),
            ..cloud_binding(&root)
        };
        let refused = Daemon::try_start(&fixture, Some(&binding), &[])
            .err()
            .unwrap_or_else(|| panic!("posture {key} was accepted"));
        assert_eq!(refused.status.code(), Some(78), "{}", refused.output);
        assert!(
            refused.output.contains(r#""code":"posture_unsupported""#)
                && refused
                    .output
                    .contains(&format!(r#""field":"posture.{key}""#)),
            "{key}: {}",
            refused.output
        );
        assert!(!refused.output.contains(BOUND_VALUE) && !refused.output.contains(ROOT_SECRET));
    }
}

#[test]
fn argv_withholding_needs_no_frame_and_no_posture() {
    let fixture = Fixture::new();
    // An explicit, host-selected unbound mode: no frame, no ack fd.
    let _daemon = Daemon::try_start_args(
        &fixture,
        None,
        &[],
        &["--det-withhold", "ANTHROPIC_API_KEY,OPENAI_API_KEY"],
    )
    .unwrap_or_else(|refused| panic!("argv withholding was refused: {}", refused.output));
    let hello = hello(&mut fixture.connect());
    assert_eq!(
        hello["det_withheld"],
        json!(["ANTHROPIC_API_KEY", "OPENAI_API_KEY"]),
        "{hello}"
    );
}

#[test]
fn a_daemon_started_without_the_new_flags_is_unchanged() {
    let fixture = Fixture::new();
    let _daemon = Daemon::start(&fixture, None, &[]);
    let hello = hello(&mut fixture.connect());
    assert!(hello.get("det_withheld").is_none(), "{hello}");
}

#[test]
fn a_frame_that_narrows_the_argv_withhold_set_is_refused() {
    let fixture = Fixture::new();
    let root = spec(vec![det("p", "true", &[])]);
    let mut argv: Vec<&'static str> = AGENT_ONLY.iter().map(|(name, _)| *name).collect();
    argv.push("GOOGLE_API_KEY");
    let binding = Binding {
        argv_withhold: Some(argv),
        ..cloud_binding(&root)
    };
    let refused = Daemon::try_start(&fixture, Some(&binding), &[])
        .err()
        .expect("a narrowing frame was accepted");
    assert_eq!(refused.status.code(), Some(78), "{}", refused.output);
    assert!(
        refused.output.contains(r#""code":"withhold_narrowed""#)
            && refused.output.contains(r#""field":"GOOGLE_API_KEY""#),
        "{}",
        refused.output
    );
}

#[test]
fn a_requested_frame_without_its_ack_fd_fails_closed_never_unbound() {
    let fixture = Fixture::new();
    let refused = Daemon::try_start_args(&fixture, None, &[], &["--det-frame-stdin"])
        .err()
        .expect("a frame without an ack fd fell back to an unbound daemon");
    assert_eq!(refused.status.code(), Some(78), "{}", refused.output);
    assert!(
        refused.output.contains(r#""code":"ack_fd_invalid""#),
        "{}",
        refused.output
    );
}
