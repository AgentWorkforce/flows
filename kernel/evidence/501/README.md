# PR #501 evidence — regenerated for the review follow-ups

Every log here except the one marked historical prints the
`git rev-parse HEAD` it ran at:

- kernel, clippy, mutation and bundle logs: `921a69d2` (the kernel code this
  directory is committed with);
- SDK gate, authored-node and full-SDK logs: `05ab5849`. Nothing under
  `packages/` changed between `05ab5849` and `921a69d2`
  (`git diff --stat 05ab5849 921a69d2 -- packages` is empty).

The commit that refreshes these logs changes nothing outside
`kernel/evidence/501/`, so they describe the code under review.

The previous logs in this directory did not: `green-kernel.txt` reported 53 and
72 lib tests where the tree had 64 and 85, `sdk-typecheck-build.txt` named a
`2.0.22` surface that never existed on this branch, the authored-node log
listed a test that was never committed and omitted two that were, the clippy
header claimed a filter it did not apply, and the mutation transcript was run
over an uncommitted working tree with commands that could not be replayed.
They were replaced, not edited.

Captured output is verbatim except that trailing whitespace on captured lines
was stripped (`sed 's/[ \t]*$//'`) so `git diff --check` passes. Absolute
scratch paths are left as they were.

| file | command | result |
|---|---|---|
| `green-kernel.txt` | `cd kernel && cargo test --workspace --no-run`, then `cargo test --workspace` | both exit 0 at `921a69d2`; every test target compiles; 332 passed, 0 failed (`relayflowd` lib 64, `relayflowd_core` lib 86, `relayflowd_journal` lib 32, …) |
| `clippy.txt` | `cd kernel && cargo clippy --workspace --all-targets -- -D warnings` | exit 101 on pre-existing findings |
| `clippy-all-targets-warn.txt` | `cd kernel && cargo clippy --workspace --all-targets` (warnings not denied, so every crate and target is reached) | exit 0; the full, **unfiltered** workspace warning log. It includes files this PR does not touch. None of its 21 warning locations is on a line this PR adds or changes relative to `main` |
| `mutation.sh`, `mutations/*.patch`, `mutation-transcript.txt` | `sh kernel/evidence/501/mutation.sh` from the repository root | 0 expectations missed, exit 0; see below |
| `sdk-typecheck-build.txt` | documented gate (`.github/workflows/publish.yml`): build + pack the local surface (`@relayflows/surface@2.0.38`), install it `--no-save` into the SDK, `npm run typecheck && npm run typecheck:tests && npm run build` | every step exit 0 |
| `sdk-full-darwin.txt` | `cd packages/sdk && RELAYFLOWD_BIN=<kernel/target/debug/relayflowd> npx vitest run` on macOS (darwin-arm64) | **not green**: 3485 passed, 170 failed, 71 skipped; exit 1. See below. The authoritative full SDK suite is CI `linux-x64-artifact` at the pushed head |
| `green-sdk-bundle-pristine.txt` | dist built through the documented override, deps restored with `npm ci --ignore-scripts`, then `npx vitest run tests/bundle.test.ts` (it reads no `RELAYFLOWD_BIN`) | 26/26, exit 0 |
| `green-sdk-authored-node-runtime.txt` | the standalone suite under bun 1.4.0 and Node 22.23.2 (`mise`), `FLOWS_BUILD_BUN` / `FLOWS_AUTHORED_NODE` absolute | 16/16 — the committed suite's 16 tests by name, exit 0 |
| `historical-139690f7-codex-live-probe.txt` | **historical, not re-run.** One bounded live run of `codex-cli 0.154.0` recorded at `139690f7` | It needs a live, credentialed Codex session and was not reproduced at `05ab5849`. Kept for its account of the direct-transport behaviour at that commit; it is not evidence about this head |

## Mutation check

`mutation.sh` is replayable as written: every command is printed exactly as
it runs and is followed by its own exit code (cargo's, not a pipe's) and the
outcome it was expected to have; the script exits nonzero if any expectation is
missed. Each mutation is a committed patch applied with `git apply` and undone
with `git checkout`; `git diff --exit-code` proves the tree identical to the
commit before the first run and after every restore.

| mutation | what it disables | caught by |
|---|---|---|
| `a-manual-park-off` | a worker-reported `crashed` / `lease_expired` parks a `manual` step | 2 `machine::recovery_tests` fail, exit 101 |
| `b-torn-park-repair-off` | resume journals the `wait.human` a torn park never wrote | `recovery_journals_the_wait_human_a_torn_manual_park_never_wrote` fails, exit 101 |
| `c-refused-dispatch-retry-off` | a `PinMismatch` refusal re-elects the step | `refused_dispatch_is_re_elected_within_max_iterations_only` and `parallel_driver::backpressured_or_mismatched_lane_does_not_drop_a_later_dispatch` fail, exit 101 |
| `d-refusal-not-charged` | the fold charges a refused dispatch an iteration (what bounds re-election) | `refused_dispatch_is_re_elected_within_max_iterations_only` fails, exit 101 |

GREEN before the first mutation and after the last restore.

## The full SDK suite on this host (`sdk-full-darwin.txt`)

It is committed as run, failures included, because it is not a green record
and the previous `green-sdk.txt` (154 files / 2410 tests at an older commit)
was not evidence about this head either. The run shared the machine with
other agents at load averages of 15-32. What the failures are:

- 29 failures state `Hosted base source snapshotting requires Linux` or
  `hosted extension isolation requires Linux`: Linux-only paths, run in CI.
- The rest are timeouts, `ENOENT`/`ENOTEMPTY` temp-directory races and
  process-reaping deadlines.
- The 45 failing files were re-run at load ~4 on this head and on the merged
  base without the review commits (`ffefb6f7`), same binary: 120 failed on this
  head, 128 on the base. The failure sets differ run to run in both.
- The 11 files whose failures appeared only on this head were re-run serially:
  158/160 pass; the 2 failures are different tests from the first run.
- `pty-sidechannel`, `wrapper-exit-drain` and `named-gate-journal` (the PR-only
  names nearest the changed code) pass twice on both trees: 28/28 here
  (one new test), 27/27 on the base.
- The known `named-gate-diagnostics` EPIPE flake (#598) did not occur: 17/17.

## Pre-existing, observed, not fixed here

- `flows check` accepts a step-level `cwd:` that `relayflowd` refuses at
  `run.start` (`invalid_spec: unknown field "cwd"`), recorded in the
  historical codex probe.
- The SDK does not compile against the *published* `@relayflows/surface`
  (`AgentOptions.recoveryMode`); the documented gate builds it against the
  locally packed surface, as `publish.yml` does.
