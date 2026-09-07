# Issue 225 — gate 7 slice 1

The red test was committed before implementation in `fa54257`. It submits two
deterministic steps with placement requirements: the first copies a source file
into a relative output file, the second reads that output. Resume runs from a
different working directory. The initial failure was the kernel rejecting
`requirements`, captured verbatim in [red.txt](red.txt).

The implementation adds:

- Authoring and kernel `requirements`: execution (`batch` or `interactive`),
  workspace, network, expected duration, and cost/latency/reliability/balanced
  preference. Duration lowers from `expectedDurationMs` to `expected_duration_ms`.
  Provider names and revisions are not authoring fields. Shared canonical JSON,
  hash, and an acceptance/rejection corpus pin both dialects.
- `step.routed`: profile, provider, fallbacks attempted, and optional provider
  workspace identity. A step has one routing fact, written before execution and
  retained on retries and epoch rollover. `StepDispatch.routing` carries that
  fact to the adapter. Duplicate routing writes fail inside the SQLite append
  transaction. A failed append prevents attempt start and dispatch.
- Fixed local batch placement for deterministic steps. Declaring requirements
  opts into a shared worktree unless `workspace: false`; submission records its
  canonical directory. Attempts and completions record its Git base commit.
  Each command executes in the recorded directory, including after resume from
  elsewhere. Local interactive execution and unavailable source commits are
  refused before submission. Network is a capability need (`false` means no
  need), not a network isolation policy; duration and preference are hints for
  later ranking.
- The default in-process worker pin source reads declared worktree base commits
  instead of returning empty workspace pins. Remote workers continue to report
  their own revision facts through the existing override/protocol.

## Scope and integration boundary

This is a declaration and journal slice, not all of gate 7. No sandbox, source
uploader, root lease manager, provider SDK, or ranking engine is introduced.
`StepDispatcher::routing_decision` is the adapter hook for an existing provider
orchestrator; it is invoked only until its decision is durable. Dispatch must
consume the recorded decision without selecting another provider on retry.
The default attached-worker dispatcher rejects unsupported placement declarations.

The remote-shaped test uses `test-cloud-adapter`, an in-process test dispatcher.
It is **not a live cloud run**. No claim is made that Daytona source sync,
remote deterministic execution, or actual sandbox destruction was verified.
Connecting the flows transport to cloud's existing code-sync and sandbox
orchestration remains integration work. Git pins here are worktree base commits,
as allowed by Appendix A; they are not snapshots of uncommitted files. Agent
reset/inspect/manual recovery retains its existing revision protocol.

Existing specs without requirements keep their execution behavior; local
worktree pinning is enabled by the new declaration. Their routing choices are
still recorded when execution is admitted.

## Captured commands and output

Each transcript contains the literal command, stdout/stderr, and exit code.

- [Red regression](red.txt):
  `cd kernel && cargo test --workspace --test crash_resume placement:: -- --nocapture`
- [Complete kernel gate](green-kernel.txt):
  `cd kernel && cargo test --workspace`
- [SDK parity and type checks](green-sdk.txt):
  `cd packages/sdk && node node_modules/vitest/vitest.mjs run tests/placement.test.ts tests/spec-parity.test.ts`
  plus `node node_modules/typescript/bin/tsc --noEmit` and
  `node node_modules/typescript/bin/tsc -p tsconfig.type-tests.json` in that directory.

The SDK dependencies were copied into this worktree from the existing
`flows-212-channels-wt/packages/sdk/node_modules` after the local `npm` process
stalled before installing dependencies. No dependency manifest or lockfile was
changed for that copy. The Rust dev dependency on the already-used `rusqlite`
crate supports an actual SQLite failure-injection test.
