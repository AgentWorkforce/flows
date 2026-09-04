//! JSON Schema declaration gate: a schema is legal only if compiling it
//! succeeds **and** validating with it is guaranteed to terminate.
//!
//! Compilation alone is not enough. `jsonschema` happily compiles a schema
//! whose `$ref` graph contains a cycle that never descends into a child of the
//! instance (`$defs.a -> $defs.b -> $defs.a`), and then recurses without bound
//! the first time it validates an output. A Rust stack overflow aborts the
//! process; it cannot be caught, so the bound has to be structural and has to
//! run before the schema is accepted — before a journal exists and before the
//! step's command runs.
//!
//! The rule: follow only the **in-place** applicators (`$ref`, `allOf`,
//! `anyOf`, `oneOf`, `not`, `if`/`then`/`else`, `dependentSchemas`), which
//! re-apply a subschema to the *same* instance. A cycle among those makes no
//! progress and cannot terminate. Cycles that pass through a **child**
//! applicator (`properties`, `items`, `prefixItems`, ...) are ordinary
//! recursive schemas: each step consumes one level of the instance, so they
//! terminate, and they stay legal.
//!
//! `sdk/src/json-schema-bound.ts` implements the same rule, and
//! `testdata/json-schema-bound-cases.json` is the corpus both sides are pinned
//! to, so kernel and SDK agree on which schemas are legal by construction
//! rather than by coincidence of two engines' overflow behaviour.

use std::collections::{BTreeMap, HashMap, HashSet};

use serde_json::Value;

/// Named refusal shared with the SDK and with the parity corpus.
pub(crate) const UNBOUNDED_REF_CYCLE: &str = "unbounded $ref cycle";

/// Reference keywords: apply the referenced schema to the same instance.
const REFERENCE_KEYWORDS: [&str; 3] = ["$ref", "$dynamicRef", "$recursiveRef"];
/// In-place applicators taking a single subschema.
const IN_PLACE_SINGLE: [&str; 4] = ["not", "if", "then", "else"];
/// In-place applicators taking an array of subschemas.
const IN_PLACE_ARRAY: [&str; 3] = ["allOf", "anyOf", "oneOf"];
/// In-place applicators taking a map of subschemas.
const IN_PLACE_MAP: [&str; 2] = ["dependentSchemas", "dependencies"];
/// Child applicators taking a single subschema — these consume one level of
/// the instance, so a cycle through them terminates.
const CHILD_SINGLE: [&str; 7] = [
    "additionalItems",
    "additionalProperties",
    "contains",
    "items",
    "propertyNames",
    "unevaluatedItems",
    "unevaluatedProperties",
];
/// Child applicators taking a map of subschemas.
const CHILD_MAP: [&str; 2] = ["properties", "patternProperties"];
/// Child applicators taking an array of subschemas.
const CHILD_ARRAY: [&str; 1] = ["prefixItems"];

pub(crate) fn validate_declaration(schema: &Value) -> Result<(), String> {
    compile(schema).map(|_| ())
}

/// Compile a declaration through the same gate the declaration preflight uses.
/// `verify` calls this rather than `jsonschema::validator_for` directly, so a
/// journal written by an older kernel — which still holds an unbounded schema —
/// fails its gate with a verdict instead of aborting the daemon on every
/// resume.
pub(crate) fn compile(schema: &Value) -> Result<jsonschema::Validator, String> {
    bound_declaration(schema)?;
    jsonschema::validator_for(schema).map_err(|error| error.to_string())
}

/// Refuse a declaration whose validation is not guaranteed to terminate.
fn bound_declaration(schema: &Value) -> Result<(), String> {
    if !schema.is_object() {
        // Boolean schemas carry no references.
        return Ok(());
    }
    let Scopes {
        resources,
        anchors,
        base_at,
        has_ids,
    } = collect_scopes(schema);
    let mut in_place: BTreeMap<String, Vec<String>> = BTreeMap::new();
    let mut seen: HashSet<String> = HashSet::new();
    let mut queue: Vec<String> = vec![String::new()];
    seen.insert(String::new());

    while let Some(pointer) = queue.pop() {
        let Some(object) = schema.pointer(&pointer).and_then(Value::as_object) else {
            continue;
        };
        let mut here: Vec<String> = Vec::new();
        let mut children: Vec<String> = Vec::new();

        for keyword in REFERENCE_KEYWORDS {
            let Some(reference) = object.get(keyword).and_then(Value::as_str) else {
                continue;
            };
            // Walking to the nearest `$id` is the expensive part, so it is done
            // only for a node that actually carries a reference, and skipped
            // entirely for a document with no `$id` anywhere.
            // A reference is resolved as a URI against the base URI in
            // effect at this node (RFC 3986 §5), and only then as a fragment
            // inside the resource it names. Keying on a leading `#` instead
            // would miss the standard 2020-12 *compound schema document* form
            // (spec §9.3, what every bundler emits), where a `$ref` written as
            // a URI names an `$id` declared inside this same document and
            // `jsonschema` resolves it from the document's own resource map.
            let base_uri = if has_ids {
                base_at.get(&pointer).map(String::as_str).unwrap_or("")
            } else {
                ""
            };
            // A reference that names no resource declared in this document is
            // left opaque, on a claim narrower than the one this comment used
            // to make. It is either (a) remote, which `validator_for` refuses
            // below because no retriever is configured, or (b) a meta-schema
            // bundled with `jsonschema`, which cannot reference back into this
            // document and so cannot close a cycle rooted here. Neither can
            // participate in an unbounded in-place cycle.
            //
            // The older claim — "validator_for refuses anything the bound
            // cannot resolve" — was true for remote resources and FALSE for an
            // in-document `$id`, which is resolved from the resource map and
            // then overflows. That gap is what this resolver closes.
            if let Some(target) = resolve(base_uri, reference, &resources, &anchors) {
                if schema.pointer(&target).is_some() {
                    here.push(target);
                }
            }
        }
        for keyword in IN_PLACE_SINGLE {
            if object.contains_key(keyword) {
                here.push(child_pointer(&pointer, keyword));
            }
        }
        for keyword in IN_PLACE_ARRAY {
            collect_array(object, &pointer, keyword, &mut here);
        }
        for keyword in IN_PLACE_MAP {
            collect_map(object, &pointer, keyword, &mut here);
        }
        for keyword in CHILD_SINGLE {
            match object.get(keyword) {
                // draft-04/07 tuple form: `items` may be an array of schemas.
                Some(Value::Array(items)) => {
                    for index in 0..items.len() {
                        children.push(format!("{}/{index}", child_pointer(&pointer, keyword)));
                    }
                }
                Some(_) => children.push(child_pointer(&pointer, keyword)),
                None => {}
            }
        }
        for keyword in CHILD_MAP {
            collect_map(object, &pointer, keyword, &mut children);
        }
        for keyword in CHILD_ARRAY {
            collect_array(object, &pointer, keyword, &mut children);
        }

        for next in here.iter().chain(children.iter()) {
            if seen.insert(next.clone()) {
                queue.push(next.clone());
            }
        }
        // `$defs`/`definitions` are containers, not applicators: their members
        // are reachable only through a `$ref`, so an unused degenerate
        // definition is never validated and stays legal.
        if !here.is_empty() {
            in_place.insert(pointer, here);
        }
    }

    match find_cycle(&in_place) {
        Some(cycle) => Err(format!(
            "{UNBOUNDED_REF_CYCLE}: {} — this cycle re-applies to the same instance, so validation would not terminate",
            cycle
                .iter()
                .map(|pointer| display_pointer(pointer))
                .collect::<Vec<_>>()
                .join(" -> ")
        )),
        None => Ok(()),
    }
}

fn collect_array(
    object: &serde_json::Map<String, Value>,
    pointer: &str,
    keyword: &str,
    out: &mut Vec<String>,
) {
    if let Some(Value::Array(items)) = object.get(keyword) {
        for index in 0..items.len() {
            out.push(format!("{}/{index}", child_pointer(pointer, keyword)));
        }
    }
}

fn collect_map(
    object: &serde_json::Map<String, Value>,
    pointer: &str,
    keyword: &str,
    out: &mut Vec<String>,
) {
    if let Some(Value::Object(entries)) = object.get(keyword) {
        for (name, value) in entries {
            // draft-07 `dependencies` values may be a property-name array.
            if value.is_object() || value.is_boolean() {
                out.push(format!(
                    "{}/{}",
                    child_pointer(pointer, keyword),
                    escape(name)
                ));
            }
        }
    }
}

fn child_pointer(pointer: &str, key: &str) -> String {
    format!("{pointer}/{}", escape(key))
}

fn escape(segment: &str) -> String {
    segment.replace('~', "~0").replace('/', "~1")
}

fn display_pointer(pointer: &str) -> String {
    if pointer.is_empty() {
        "#".to_owned()
    } else {
        format!("#{pointer}")
    }
}

/// Split `<uri>#<fragment>` into its two halves. `None` means the reference
/// carried no `#` at all, which is distinct from an empty fragment.
fn split_fragment(reference: &str) -> (&str, Option<&str>) {
    match reference.find('#') {
        Some(index) => (&reference[..index], Some(&reference[index + 1..])),
        None => (reference, None),
    }
}

fn strip_fragment(uri: &str) -> &str {
    split_fragment(uri).0
}

/// RFC 3986 §3.1 scheme detection: `scheme ":"`, where scheme starts with a
/// letter. Used to tell an absolute URI from a relative reference.
fn has_scheme(reference: &str) -> bool {
    let mut chars = reference.char_indices();
    match chars.next() {
        Some((_, first)) if first.is_ascii_alphabetic() => {}
        _ => return false,
    }
    for (index, character) in chars {
        if character == ':' {
            return index > 0;
        }
        if !(character.is_ascii_alphanumeric()
            || character == '+'
            || character == '-'
            || character == '.')
        {
            return false;
        }
    }
    false
}

/// RFC 3986 §5.2.4.
fn remove_dot_segments(path: &str) -> String {
    let absolute = path.starts_with('/');
    let trailing = path.ends_with('/') || path.ends_with("/.") || path.ends_with("/..");
    let mut out: Vec<&str> = Vec::new();
    for segment in path.split('/') {
        match segment {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            other => out.push(other),
        }
    }
    let mut resolved = String::new();
    if absolute {
        resolved.push('/');
    }
    resolved.push_str(&out.join("/"));
    if trailing && !resolved.ends_with('/') {
        resolved.push('/');
    }
    resolved
}

/// Split a URI into the part that a rooted path replaces (scheme + authority)
/// and the path itself, so `root + path == uri` for a hierarchical URI.
fn split_authority(uri: &str) -> (&str, &str) {
    match uri.find("://") {
        Some(index) => {
            let after = &uri[index + 3..];
            match after.find('/') {
                Some(slash) => uri.split_at(index + 3 + slash),
                None => (uri, ""),
            }
        }
        // Opaque URI (`urn:...`): there is no authority to preserve.
        None => match uri.rfind('/') {
            Some(index) => uri.split_at(index + 1),
            None => (uri, ""),
        },
    }
}

/// RFC 3986 §5.3 reference resolution, enough of it for schema identifiers.
///
/// Exactness matters less than *consistency*: every `$id` is registered
/// through this function and every `$ref` is looked up through it, so a
/// document whose identifiers are written literally — which is what a bundler
/// emits — matches regardless of how this normalizes. `collect_scopes` also
/// registers each resource under its raw `$id` string for the same reason.
fn resolve_uri(base: &str, reference: &str) -> String {
    if reference.is_empty() {
        return base.to_owned();
    }
    if has_scheme(reference) {
        return reference.to_owned();
    }
    if base.is_empty() {
        return reference.to_owned();
    }
    if let Some(rest) = reference.strip_prefix("//") {
        let scheme = base.split(':').next().unwrap_or("");
        return format!("{scheme}://{rest}");
    }
    let (root, path) = split_authority(base);
    if reference.starts_with('/') {
        return format!("{root}{}", remove_dot_segments(reference));
    }
    let merged = match path.rfind('/') {
        Some(index) => format!("{}{reference}", &path[..=index]),
        None => format!("/{reference}"),
    };
    format!("{root}{}", remove_dot_segments(&merged))
}

/// Resolve a reference to the JSON pointer of the node it names, or `None`
/// when it names nothing inside this document.
fn resolve(
    base: &str,
    reference: &str,
    resources: &HashMap<String, String>,
    anchors: &HashMap<(String, String), String>,
) -> Option<String> {
    let (uri, fragment) = split_fragment(reference);
    let (target_base, target_pointer) = if uri.is_empty() {
        (base.to_owned(), resources.get(base)?.clone())
    } else {
        let resolved = resolve_uri(base, uri);
        match resources.get(&resolved) {
            Some(pointer) => (resolved, pointer.clone()),
            // Literal fallback: the reference as written, in case this
            // resolver and the `$id` that registered the resource normalized
            // differently.
            None => (uri.to_owned(), resources.get(uri)?.clone()),
        }
    };
    match fragment {
        None | Some("") => Some(target_pointer),
        Some(pointer) if pointer.starts_with('/') => {
            Some(format!("{target_pointer}{}", percent_decode(pointer)))
        }
        Some(name) => anchors
            .get(&(target_base, percent_decode(name)))
            .cloned(),
    }
}

fn percent_decode(input: &str) -> String {
    let bytes = input.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            let hex = std::str::from_utf8(&bytes[index + 1..index + 3]).unwrap_or("");
            if let Ok(byte) = u8::from_str_radix(hex, 16) {
                out.push(byte);
                index += 3;
                continue;
            }
        }
        out.push(bytes[index]);
        index += 1;
    }
    String::from_utf8(out).unwrap_or_else(|_| input.to_owned())
}

struct Scopes {
    /// Base URI of every resource declared in this document -> its pointer.
    /// Each resource is registered under both its resolved and its raw `$id`.
    resources: HashMap<String, String>,
    /// `(base URI, anchor name)` -> pointer. Anchors are scoped to the
    /// resource that declares them, so the same name may appear under two
    /// different `$id`s without either shadowing the other.
    anchors: HashMap<(String, String), String>,
    /// Base URI in effect at each node pointer.
    base_at: HashMap<String, String>,
    has_ids: bool,
}

fn collect_scopes(root: &Value) -> Scopes {
    let mut resources: HashMap<String, String> = HashMap::new();
    let mut anchors: HashMap<(String, String), String> = HashMap::new();
    let mut base_at: HashMap<String, String> = HashMap::new();
    let mut has_ids = false;

    resources.insert(String::new(), String::new());
    let mut stack: Vec<(String, String, &Value)> = vec![(String::new(), String::new(), root)];
    while let Some((pointer, inherited, node)) = stack.pop() {
        match node {
            Value::Object(map) => {
                let mut base = inherited;
                if let Some(id) = map.get("$id").or_else(|| map.get("id")).and_then(Value::as_str)
                {
                    has_ids = true;
                    let resolved = resolve_uri(&base, strip_fragment(id));
                    resources
                        .entry(resolved.clone())
                        .or_insert_with(|| pointer.clone());
                    resources
                        .entry(strip_fragment(id).to_owned())
                        .or_insert_with(|| pointer.clone());
                    base = resolved;
                }
                base_at.insert(pointer.clone(), base.clone());
                for keyword in ["$anchor", "$dynamicAnchor", "$recursiveAnchor"] {
                    if let Some(name) = map.get(keyword).and_then(Value::as_str) {
                        anchors
                            .entry((base.clone(), name.to_owned()))
                            .or_insert_with(|| pointer.clone());
                    }
                }
                for (key, value) in map {
                    stack.push((child_pointer(&pointer, key), base.clone(), value));
                }
            }
            Value::Array(items) => {
                base_at.insert(pointer.clone(), inherited.clone());
                for (index, value) in items.iter().enumerate() {
                    stack.push((format!("{pointer}/{index}"), inherited.clone(), value));
                }
            }
            _ => {
                base_at.insert(pointer, inherited);
            }
        }
    }
    Scopes {
        resources,
        anchors,
        base_at,
        has_ids,
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Color {
    Gray,
    Black,
}

/// Iterative DFS — the checker itself must not recurse, or it would inherit
/// the very unbounded recursion it exists to refuse.
fn find_cycle(edges: &BTreeMap<String, Vec<String>>) -> Option<Vec<String>> {
    let mut color: HashMap<&str, Color> = HashMap::new();
    for start in edges.keys() {
        if color.contains_key(start.as_str()) {
            continue;
        }
        let mut stack: Vec<(&str, usize)> = vec![(start.as_str(), 0)];
        let mut path: Vec<&str> = vec![start.as_str()];
        color.insert(start.as_str(), Color::Gray);
        while !stack.is_empty() {
            let (node, index) = {
                let top = stack.last_mut().expect("stack is not empty");
                top.1 += 1;
                (top.0, top.1 - 1)
            };
            let successors = edges.get(node).map(Vec::as_slice).unwrap_or(&[]);
            if index < successors.len() {
                let next = successors[index].as_str();
                match color.get(next).copied() {
                    Some(Color::Gray) => {
                        let at = path.iter().position(|step| *step == next).unwrap_or(0);
                        let mut cycle: Vec<String> =
                            path[at..].iter().map(|step| (*step).to_owned()).collect();
                        cycle.push(next.to_owned());
                        return Some(cycle);
                    }
                    Some(Color::Black) => {}
                    None => {
                        color.insert(next, Color::Gray);
                        path.push(next);
                        stack.push((next, 0));
                    }
                }
            } else {
                color.insert(node, Color::Black);
                path.pop();
                stack.pop();
            }
        }
    }
    None
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

    fn corpus() -> Value {
        serde_json::from_str(include_str!(concat!(
            env!("CARGO_MANIFEST_DIR"),
            "/../../testdata/json-schema-bound-cases.json"
        )))
        .unwrap()
    }

    #[test]
    fn shared_declarations_and_boolean_schemas_are_validated() {
        assert!(validate_declaration(&fixture("valid")).is_ok());
        assert!(validate_declaration(&json!(true)).is_ok());
        assert!(validate_declaration(&json!(false)).is_ok());
        assert!(validate_declaration(&fixture("invalid")).is_err());
    }

    /// The bound, not the mechanism. Each refused schema **compiles cleanly**
    /// in `jsonschema`, so this test fails the moment `bound_declaration` stops
    /// running — compilation alone would accept every one of them.
    #[test]
    fn every_refused_corpus_schema_compiles_but_is_refused_by_the_bound() {
        let corpus = corpus();
        let marker = corpus["marker"].as_str().unwrap();
        let cases = corpus["refused"].as_array().unwrap();
        assert!(cases.len() >= 20, "corpus lost refusal cases");
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let schema = &case["schema"];
            assert!(
                jsonschema::validator_for(schema).is_ok(),
                "{name}: this case only proves the bound if the schema compiles"
            );
            let error = validate_declaration(schema)
                .expect_err(&format!("{name}: unbounded schema must be refused"));
            assert!(
                error.contains(marker),
                "{name}: refusal must be named {marker:?}, got {error}"
            );
        }
    }

    /// The other half of the bound: legitimate recursion stays legal.
    #[test]
    fn every_accepted_corpus_schema_is_accepted() {
        let corpus = corpus();
        for case in corpus["accepted"].as_array().unwrap() {
            let name = case["name"].as_str().unwrap();
            assert!(
                validate_declaration(&case["schema"]).is_ok(),
                "{name}: legitimate schema must stay legal, got {:?}",
                validate_declaration(&case["schema"])
            );
        }
    }

    /// The narrowed premise, tested rather than asserted in a comment.
    ///
    /// `resolve` leaves a reference naming no in-document resource opaque.
    /// That is only safe because the ENGINE refuses such a reference. The
    /// previous, wider form of this claim — "validator_for refuses anything the
    /// bound cannot resolve" — was false for an in-document `$id`, which is
    /// signoff-4's P0 in one sentence. Both halves are pinned: the bound must
    /// not claim these, and `validator_for` must refuse them. If a future
    /// `jsonschema` accepts an unresolvable reference, this fails and the
    /// opaque default has to be revisited rather than silently becoming a hole.
    #[test]
    fn references_the_bound_leaves_opaque_are_refused_by_the_engine() {
        let corpus = corpus();
        let cases = corpus["engineRefused"].as_array().unwrap();
        assert!(!cases.is_empty(), "corpus lost the engine-refused cases");
        for case in cases {
            let name = case["name"].as_str().unwrap();
            let schema = &case["schema"];
            assert!(
                bound_declaration(schema).is_ok(),
                "{name}: the bound must not claim a reference it cannot resolve"
            );
            let error = jsonschema::validator_for(schema)
                .expect_err(&format!("{name}: the engine must refuse this reference"));
            let error = error.to_string();
            assert!(
                !error.contains(UNBOUNDED_REF_CYCLE),
                "{name}: this must be the engine's refusal, not the bound's, got {error}"
            );
            assert!(
                compile(schema).is_err(),
                "{name}: the gate as a whole must refuse it"
            );
        }
    }

    /// Every reference FORM in the 2020-12 vocabulary that can name a target
    /// inside this document must be resolvable by the bound, not just the
    /// `#`-prefixed ones. Keying on `#` is what let the compound-schema-document
    /// (bundling) form through.
    #[test]
    fn in_document_uri_references_resolve_to_the_node_they_name() {
        let schema = json!({
            "$id": "https://ex.test/root",
            "$defs": {
                "a": {"$id": "https://ex.test/a", "$anchor": "nm", "type": "string"}
            }
        });
        let Scopes {
            resources, anchors, ..
        } = collect_scopes(&schema);
        for (base, reference, expected) in [
            ("", "https://ex.test/a", Some("/$defs/a")),
            ("https://ex.test/root", "a", Some("/$defs/a")),
            ("https://ex.test/root", "/a", Some("/$defs/a")),
            ("https://ex.test/root", "https://ex.test/a#nm", Some("/$defs/a")),
            ("https://ex.test/a", "#nm", Some("/$defs/a")),
            ("https://ex.test/a", "#", Some("/$defs/a")),
            ("", "https://ex.test/root", Some("")),
            ("", "https://elsewhere.test/a", None),
            ("https://ex.test/root", "#unknown-anchor", None),
        ] {
            assert_eq!(
                resolve(base, reference, &resources, &anchors).as_deref(),
                expected,
                "base {base:?} reference {reference:?}"
            );
        }
    }

    #[test]
    fn refusal_names_the_cycle_it_found() {
        let schema = json!({
            "$defs": {"a": {"$ref": "#/$defs/b"}, "b": {"$ref": "#/$defs/a"}},
            "$ref": "#/$defs/a"
        });
        let error = validate_declaration(&schema).unwrap_err();
        assert!(error.contains("#/$defs/a"), "{error}");
        assert!(error.contains("#/$defs/b"), "{error}");
    }

    /// A property literally named `$ref` is data, not a reference.
    #[test]
    fn a_property_named_ref_is_not_a_reference() {
        let schema = json!({
            "type": "object",
            "properties": {"$ref": {"type": "string"}, "allOf": {"type": "string"}}
        });
        assert!(validate_declaration(&schema).is_ok());
    }

    /// The checker must not recurse: a deep schema is bounded work, not a
    /// second stack overflow inside the guard. 1000 levels is an order of
    /// magnitude past what can even reach the daemon — `serde_json` refuses to
    /// parse past its own 128-deep nesting limit — and the checker walks it
    /// with an explicit stack.
    #[test]
    fn deeply_nested_schemas_do_not_overflow_the_checker() {
        let mut schema = json!({"type": "string"});
        for _ in 0..1_000 {
            schema = json!({"type": "array", "items": schema});
        }
        assert!(bound_declaration(&schema).is_ok());
        assert!(
            serde_json::from_str::<Value>(&schema.to_string()).is_err(),
            "serde_json is expected to refuse this depth on the wire"
        );
    }
}
