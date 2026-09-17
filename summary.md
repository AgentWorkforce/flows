Adds `f.done("declined")` for a body that deliberately chooses not to act on
its input. `declined` describes the decision without promising zero prior
effects, which makes it preferable to `no_op`.

Stacked on reviewed PR #436 at
`e86118c28e014d4a1b327876c03193d03a16c752`, on the requested current branch.
Implementation commit: `8936653dbb699dd31a5493f1a0b755882cc20587`.
PR #401 was inspected; its cancellation lowering was not imported. The original
`plan.md` and `reviewed-plan.md` are preserved.

- Surface exports `FLOW_COMPLETION_REASONS` and derives `FlowCompletionReason`
  from it. The executor validates that vocabulary before using #436's shared
  `isLoweredCompletion` / `completionMarker` path.
- Declination writes a successful deterministic marker containing
  `{"completionReason":"declined"}`. The authored-root output retains that
  verdict. Kernel reasons, protocol, status vocabulary, and schema are unchanged.
- Run and resume return exit 0, completed/ok/success, with
  `DECLINED [run_declined]`. The public diagnostic type gains severity
  `declined` and kind `run_declined`; downstream exhaustive consumers may need
  updates. Actual failures still take precedence. Kernel-owned `canceled` and
  `budget_exceeded` remain refused.
- Regression coverage includes types, lifecycle refusals, terminal submission/
  read failures, IPC marker mismatches, completed-root recovery, CLI rendering,
  live journal inspection and completed-root resume, plus SIGKILL recovery to a
  declined outcome using the existing runtime harness.

Cloud's current client validator accepts the generated report envelope. Its
projection drops diagnostics, so Cloud SDK/CLI callers still see ordinary
success. No deployed Cloud behavior is claimed. Before changing agentrelay.com
onboarding guards/examples, publish matching Surface/SDK packages, update
consumer pins and the hosted execution artifact, and exercise both guards.
No release or deployment is included.

Verification commands, complete literal output, and exit statuses are captured
in [docs/verification/declined.txt](docs/verification/declined.txt). Commands ran
with `/tmp/declined-tools/node_modules/.bin` prepended to PATH: Node 22.23.2
and Bun 1.4.0. The unmodified packaging gate installs the freshly packed Surface
with `--no-save --ignore-scripts`; no dependency override was committed.
The transcript includes initial type/test expectation failures and their reruns,
not only successful output.

The captured checks include `bash scripts/surface-package-gate.sh`, SDK
`test:prep`, `typecheck`, `build`, `typecheck:tests`,
`cd kernel && sh ../ops/cargo.sh test --workspace`, and
`cd packages/schema && bun run test`.

The full SDK command was:

```sh
RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 GIT_CONFIG_COUNT=1 GIT_CONFIG_KEY_0=protocol.file.allow GIT_CONFIG_VALUE_0=always npm --prefix packages/sdk test
```

Its final output was:

```text
 Test Files  1 failed | 110 passed | 1 skipped (112)
      Tests  7 failed | 1721 passed | 4 skipped (1732)
```

Exit status: 1. Full-suite verification is not green. The seven failing
`live-kernel.test.ts` cases reproduce on the exact dependency base under the
same parent package scope and tool environment. The transcript captures each
failure and a comparison of exact test names, error messages, and assertion
diffs; this is not merely a comparison of failure counts. A separate Git
fixture initially failed because file transport was disabled; the scoped
environment above allows its temporary local remote and it then passes.
The baseline uses its own packed Surface, not the new authored vocabulary.

The final focused command, run at the implementation commit, was:

```sh
git rev-parse HEAD && npm --prefix packages/sdk run build && cd packages/sdk && RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd ./node_modules/.bin/vitest run tests/authored-declined*.test.ts tests/authored-root.test.ts tests/authored-node-result.test.ts tests/authored-node-runtime.test.ts tests/authored-flow-lifecycle-executor.test.ts tests/direct-input.test.ts tests/cloud-run.test.ts tests/authored-step-failed*.test.ts
```

```text
 Test Files  11 passed (11)
      Tests  161 passed (161)
```

Exit status: 0. Complete output in the linked transcript includes the new
SIGKILL-to-declined case and the existing crash cases. No mutation verification
is claimed.
