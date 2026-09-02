use relayflowd::Engine;
use relayflowd_core::RunSpec;
use serde_json::{Value, json};

#[test]
fn invalid_json_schema_is_refused_before_journal_or_command() {
    let directory = tempfile::tempdir().unwrap();
    let marker = directory.path().join("command-ran");
    let schema: Value = serde_json::from_str(include_str!(concat!(
        env!("CARGO_MANIFEST_DIR"),
        "/../../testdata/json-schema-invalid.json"
    )))
    .unwrap();
    let spec = RunSpec::parse(&json!({
        "steps": [{
            "id": "schema",
            "type": "deterministic",
            "command": format!("touch {}", marker.display()),
            "verification": {"json_schema": schema}
        }]
    }))
    .unwrap();

    let error = Engine::new(directory.path())
        .start(spec, "test", None)
        .unwrap_err();

    assert!(error.to_string().contains("invalid run spec"), "{error:#}");
    assert!(
        !marker.exists(),
        "invalid spec must not execute its command"
    );
    assert_eq!(
        std::fs::read_dir(directory.path()).unwrap().count(),
        0,
        "invalid spec must not create a journal or registry"
    );
}
