# NEXT — work package for this tick

**Scope:** Make CI run the suites it already has. CI task, `.github/` only.

This run is pinned to **the CI coverage gap** and must not work on any other
gate. It is a small change with an outsized effect, and it is the reason six of
eight independent signoffs on 2026-09-03 found P0s in PRs that were green.

## Objective

`.github/workflows/cloud-runtime-artifact.yml` is the repository's ONLY
workflow. Verified on 2026-09-03:

- The only cargo invocation is `cargo build --locked --release -p relayflowd`.
  **`cargo test` appears nowhere.** The entire kernel suite — 130 tests — never
  runs in CI.
- Vitest runs exactly **four** files:
  `typed-output`, `validate`, `spec-parity`, `deterministic-llm`. The other ~22
  SDK test files never run.

Every kernel-side defect found on 2026-09-03 was invisible to CI by
construction: an exactly-once double-fire where one effect fired twice; a
`$ref` cycle that aborted the daemon and re-ran the effect on every resume
(4 executions of one logical step); and two tests in the tree that encoded
**opposite** contracts and both passed, because neither ran.

## What to do

Add the missing coverage to `.github/workflows/cloud-runtime-artifact.yml`.
The job already installs a Rust toolchain and builds the kernel, so the
marginal cost of testing it is the test run itself.

1. Run the kernel suite: `cargo test --workspace` from `kernel/`, using
   `ops/cargo.sh` the way the repo does elsewhere.
2. Run the whole SDK suite rather than four named files. Note `npm test` does
   `test:prep && typecheck && build` first — a bare `vitest run` fails ~6 files
   because `sdk/dist` does not exist. Use the repo's own script rather than
   inventing an invocation.
3. Keep the existing artifact build, verify and smoke steps working. Do not
   restructure the workflow; add coverage.

## Constraints

- **`.github/` only.** Do not fix any test this newly exposes. If enabling the
  suites turns CI red, that is the correct and expected outcome — report
  exactly which tests fail and stop. A red CI that tells the truth is the
  deliverable; a green CI that runs nothing is what we have.
- Do not touch `kernel/`, `sdk/`, or `testdata/`.
- Do not add a second workflow file.

## Definition of done

ALL of the following must hold:

1. `.github/workflows/cloud-runtime-artifact.yml` runs `cargo test --workspace`
   and the full SDK suite.
2. You have run both suites LOCALLY and pasted the literal commands and their
   output tails with test counts, so the change is grounded in what actually
   passes rather than in what you expect CI to do.
   - `cd kernel && PATH="$HOME/.cargo/bin:$PATH" RUSTUP_TOOLCHAIN=stable sh ../ops/cargo.sh test --workspace`
   - `cd sdk && ./node_modules/.bin/vitest run` (after a build; `npx` hangs on
     some hosts, use `./node_modules/.bin/`)
3. If either suite is red locally, you STOP and report which tests fail with
   their literal output. Do not fix them. Do not weaken the workflow to go
   green.
4. `sdk/tests/live-kernel.test.ts` needs a built `relayflowd`; if it cannot
   collect in your sandbox, say so explicitly rather than reporting a pass that
   excluded it.
5. As your LAST action, run `git status --porcelain` and paste it.

## Why this and not a product change

A sandbox cannot deliver — no git remote, no GitHub token — so its output is a
patch a human applies. That makes a small, self-contained, high-leverage
change the right shape for a tick. This one is three lines of intent, needs no
product knowledge to review, and every future tick benefits from it.

The previous contents of this file described building `sdk/src/worker.ts`. That
file exists and gate-2 workloads run against it; the package was complete and
the file had not been updated. A tick that assesses against a finished work
package burns a whole cycle, so treat a stale NEXT.md as a defect in its own
right and say so in your assess step if you find one.
