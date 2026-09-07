# Issue #212 verification transcripts

- `red-channel.txt`: `cd kernel && cargo test -p relayflowd --test crash_resume channels_sigkill_resume -- --nocapture` (exit 101). Captured before implementation and committed with the test in `38dcef9`. The failure is `unsupported_verb: unknown journal protocol verb channel.append`.
- `workspace.txt`: `cd kernel && cargo test --workspace` (exit 0). Full captured stdout and stderr, including the two channel integration tests, three pure channel tests, and four transactional channel tests.

The final fixture additionally declares each agent's outgoing stream using the existing `surfaces.streams` field. The implementation checks that declaration for writes. No authoring schema or SDK changes are included. These are test-first red/green transcripts, not mutation-verification evidence.
