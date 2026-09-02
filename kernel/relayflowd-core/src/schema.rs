use serde_json::Value;

pub(crate) fn validate_declaration(schema: &Value) -> Result<(), String> {
    jsonschema::validator_for(schema)
        .map(|_| ())
        .map_err(|error| error.to_string())
}

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::*;

    fn fixture(name: &str) -> Value {
        let source = match name {
            "valid" => include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../testdata/json-schema-valid.json"
            )),
            "invalid" => include_str!(concat!(
                env!("CARGO_MANIFEST_DIR"),
                "/../../testdata/json-schema-invalid.json"
            )),
            _ => unreachable!(),
        };
        serde_json::from_str(source).unwrap()
    }

    #[test]
    fn shared_declarations_and_boolean_schemas_are_validated() {
        assert!(validate_declaration(&fixture("valid")).is_ok());
        assert!(validate_declaration(&json!(true)).is_ok());
        assert!(validate_declaration(&json!(false)).is_ok());
        assert!(validate_declaration(&fixture("invalid")).is_err());
    }
}
