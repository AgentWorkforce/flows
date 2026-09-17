# PR 245 verification (2026-09-10)

The recorded commands and complete outputs are adjacent to this file.
The full SDK run uses the daemon built from this checkout and the local
surface 2.0.9 tarball. It preceded the final model-syntax regression; the later
focused run includes that additional test. The subsequent review follow-up
adds diagnostic-selection and failure-contract regressions; its captured
build, typechecks, and seven-suite run are in `review-followup.txt`. The unchanged package gate verifies
the 2.0.9 manifests and surface tarball with Bun 1.4.0; the host Bun 1.3.14
cannot read the repository lockfile.

A full-suite invocation from the repository root (`sdk-wrong-cwd.txt`) failed:
six assertions depend on the SDK working directory, and one wrapper abort
readiness assertion timed out. Running from `packages/sdk` produced the final
output in `sdk-full.txt`, including that abort test. No tests were weakened.

- `sdk-focused.txt`: named declarations, overrides, before-body refusal,
  direct CLI refusal kinds, malformed model syntax, and declarative preflight.
- `named-test-root-cwd.txt`: the new live suite also works from the repository
  root without RELAYFLOWD_BIN; its fallback is relative to the test file.
- `sdk-full.txt`: full SDK run; three provider/environment-dependent skips
  are visible in the output.
- `kernel-tests.txt`: full Rust workspace tests, including crash/resume tests.
- `packed-consumer.txt`: the unchanged package gate, including surface tests,
  TypeScript regressions, and the packed runtime and type consumers.

The live named-agent test uses two distinct local wrapper executables, a real
daemon, and a real SDK worker. It asserts CLI identity and model for both
named selections, a combined override, model-only and CLI-only overrides,
and one successful model probe per distinct pair. It does not claim to test
provider service availability.

For the negative control in `named-selection-mutated.txt`, the exact change
was `{ agent: name }` -> `{ agent: Object.keys(namedAgents!)[0] }` in
`packages/sdk/src/authored-flow-agents.ts`. The original bytes were saved,
the live test was run and failed on fixer's returned identity/model, and the
saved bytes were restored byte-for-byte before the passing run recorded in
`named-selection-restored.txt`. Both command outputs and exits are included.
