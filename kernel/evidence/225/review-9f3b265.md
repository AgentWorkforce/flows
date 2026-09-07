# Maintainability blockers at 9f3b265

Both requested blockers are addressed:

1. `StepDispatcher::starting_pins` documents the local filesystem/Git default,
   its failure conditions, and the overrides remote dispatchers must supply.
   `reserved_starting_pins` documents that its default delegates to that same
   behavior. This is a documentation correction, with no pin-source behavior change.
2. `StateError::InvalidRouting` carries `step` and `detail`. Duplicate decisions
   report `routing decision already recorded`; malformed decisions identify
   `profile`, `provider`, `workspace`, or the blank fallback's array index.
   `RoutingDecision::validate` is the shared field validator for engine admission,
   SQLite routing admission, state replay, and epoch replay. Unknown steps retain
   their own error, and attempt-scoped routing has its own detail. Routing replay
   moved into `state/routing.rs` to keep `state.rs` below 500 lines.

The new tests check diagnostic agreement across SQLite append, replay, and epoch
replay, plus transaction rollback and preservation of the original routing fact
on duplicate admission. Existing tests and review gates were not edited.

Other review concerns are outside this repair. In particular, this does not
claim to change epoch-summary write admission, source-revision selection,
workspace inheritance, or execution/pinning failure precedence.

Literal commands and complete captured output:

- [Failing diagnostic tests before the fix](review-9f3b265-red.txt):
  `cd kernel && cargo test --workspace --test routing_diagnostics`
- [Full workspace gate after the fix](review-9f3b265-green.txt):
  `cd kernel && cargo test --workspace`
