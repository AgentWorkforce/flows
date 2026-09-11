# Slice Q verification

## PR #338 Bugbot follow-up

Rebased onto `origin/main` at `494f2a11`. Unattended, passive, and incomplete
subscribers now allow stdin EOF after a 100ms startup drive-attachment window.
Late drive greetings are rejected without setting the intervention marker.
Drive input pauses its socket until each child write completes, including
writes that exceed the pipe's buffer capacity. Arbitrary-time drive attachment
remains a terminal/session transport follow-up, documented in SURFACE.md.

After SDK `npm ci --ignore-scripts` and repository-root
`npm install ./packages/surface --prefix packages/sdk --no-save --ignore-scripts`,
ran from `packages/sdk`:
`npm run typecheck && ./node_modules/.bin/vitest run tests/worker-cli.test.ts tests/pty-sidechannel.test.ts`.
Exit 0; literal command and output: [bugbot-fixes.txt](bugbot-fixes.txt).
This is focused SDK regression evidence, not a new live-provider acceptance run.

## Original slice evidence

This is a minimal byte-stream proof for #334, with completion markers and
resume/replay protection. Actual PTY allocation, wrapper-session attachment,
crash-safe intervention recording before completion, and the companion
agent-relay external-pty client remain follow-ups (see SURFACE.md §5).

Run/step IDs already arrive in AgentWorker's kernel dispatch; no redundant
identity plumbing was added to authored-worker-step.ts. This tree has no
separate resume.ts: resume lives in cli/run.ts and argument parsing in cli.ts.

All commands ran in this worktree on 2026-09-11. Each linked file is captured
command output. Exit statuses below refer to the completed tool processes.

## SDK

From packages/sdk:

- `npm run typecheck` — exit 0, [output](typecheck.txt).
- `npm run typecheck:tests` — exit 0, [output](typecheck-tests.txt).
- `npm run build` — exit 0, [output](build.txt).
- `npx vitest run tests/pty-sidechannel.test.ts tests/worker-cli.test.ts tests/worker-cli-abort.test.ts tests/cli-replay.test.ts`
  — exit 0, 57 passed, [output](sdk-focused.txt).
- `npx vitest run tests/cli.test.ts -t 'human-influenced resume'`
  — exit 0, 1 passed / 63 excluded by filter, [output](resume-cli.txt).
- `RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/3923540030/debug/relayflowd npx vitest run`
  — exit 1, [initial output](sdk-initial.txt). Bun was absent from PATH,
  the live Claude analyzer was unavailable, and one live-kernel test timed out.
- `PATH=/Users/khaliqgant/.bun/bin:$PATH RELAYFLOWS_ALLOW_ANALYZER_SKIP=1 RELAYFLOWD_BIN=/Users/khaliqgant/.relayflows-toolchain/target/3923540030/debug/relayflowd npx vitest run`
  — exit 0, 1215 passed / 4 skipped, [final output](sdk-final.txt).
  This is not gate-2/live-analyzer acceptance evidence. The analyzer skip is
  explicit; the initial unskipped failure is retained above.

Dependencies: SDK `npm ci --ignore-scripts`, then root
`npm install ./packages/surface --prefix packages/sdk --no-save --ignore-scripts`.
The local surface needed a build; its pre-existing lockfile was out of sync,
so it was installed with `npm install --ignore-scripts --package-lock=false`
and built with `npm run build`. No dependency manifests/locks changed.

## Rust

From the repository root unless otherwise noted:

- `PATH=/Users/khaliqgant/.cargo/bin:$PATH ops/cargo.sh test --manifest-path kernel/Cargo.toml --workspace`
  — exit 0, [output](rust-workspace.txt), including the new durable marker,
  refusal, unchanged-journal-on-refusal, and explicit-override test.
- From kernel: `PATH=/Users/khaliqgant/.cargo/bin:$PATH ../ops/cargo.sh build --locked --release -p relayflowd`
  — exit 0, [output](rust-release.txt).
- `PATH=/Users/khaliqgant/.cargo/bin:$PATH ops/cargo.sh test --manifest-path kernel/Cargo.toml -p relayflowd-core --test memoization`
  — exit 0, [output](rust-memoization.txt). This final focused run includes
  the added assertion excluding human-influenced completions from reuse.

The initial cargo invocation lacked rustc on PATH; the commands above use the
existing toolchain. `git diff --check` also exited 0.
