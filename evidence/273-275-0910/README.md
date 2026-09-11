# Issues #273 and #275: local LLM execution and output binding

The transcripts contain literal commands, working directories, exit statuses,
and captured output from this checkout on macOS arm64. SDK checks used the
current surface package installed from its release tarball, rather than a
workspace symlink. `surface-pack.txt` and `surface-install.txt` record that setup.

- `sdk-suite.txt`: full SDK suite, 959 passed and three existing skips.
- `sdk-tsc.txt`, `sdk-typecheck.txt`, `sdk-tsc-tests.txt`, `sdk-build.txt`:
  SDK source, public type contracts, selected test types, and emitted build.
- `surface-suite.txt`, `surface-regressions.txt`: surface runtime and type checks.
- `kernel-workspace.txt`: complete Rust workspace suite, including the new
  input-binding tests. `kernel-binding.txt` records their separate focused run.
- `real-provider.txt`: authenticated Codex execution of `chain.flow.ts`, exit 0,
  four completed authored steps including the terminal marker, and the final
  `message.json` artifact. The observer token is explicitly redacted.

`packages/sdk/tests/flow-executor-chain.test.ts` exercises an identified fake
CLI adapter through a real daemon: authored LLM → agent → deterministic output,
invalid JSON/schema failures, exact model allow-list refusal, JSON scalar values,
declarative binding through workers and the built CLI, and resume. Input containing
quotes, newlines, and shell metacharacters remains JSON data. The Rust SIGKILL
test resumes with an unusable original spec file and asserts one source execution
plus the original journaled value in the consumer artifact.

For the real-provider reproduction, place `chain.flow.ts` in a fresh project
with the built surface package available, authenticate Codex, and use a local
`flows.json` declaring its CLI path. The transcript records the exact invocation
and configuration. No model allow-list was changed.

The authored root is still not resumable: its steps are individual journaled runs,
as with existing authored execution. Declarative binding stays within one durable
run. Automatic local YAML LLM registration is deliberately outside this PR's
coordinator-approved scope. Selector schema paths must be explicit; `$ref` and
combinator inference are not implemented.
