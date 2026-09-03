# CI coverage gap — make CI run the suites the repo already has

Scope: `.github/` only. No `kernel/`, `sdk/`, or `testdata/` change.

## What was wrong

`.github/workflows/cloud-runtime-artifact.yml` is the repository's only
workflow. Before this change:

- the only cargo invocation was `cargo build --locked --release -p relayflowd`.
  **`cargo test` appeared nowhere** — the entire kernel suite never ran in CI;
- vitest ran exactly four named files (`typed-output`, `validate`,
  `spec-parity`, `deterministic-llm`). The suite has 25 collected files.

Every kernel-side defect found on 2026-09-03 was invisible to CI by
construction: an exactly-once double-fire where one effect fired twice; a
`$ref` cycle that aborted the daemon and re-ran the effect on each resume; and
two tests in the tree encoding opposite contracts that both "passed" because
neither was ever executed.

## The change

Two steps in one workflow file:

```yaml
      - name: Test kernel
        working-directory: kernel
        run: sh ../ops/cargo.sh test --workspace
```

and the SDK step's four named files replaced by `npm test`.

Why `ops/cargo.sh` rather than bare `cargo`: `npm test`'s `test:prep` already
shells out to the same wrapper, which redirects `CARGO_HOME`/`RUSTUP_HOME` to
`$HOME/.relayflows-toolchain`. Using it here means the two steps share one
toolchain home and target dir instead of populating two registries. The
wrapper's bootstrap branch is not taken on a runner: `dtolnay/rust-toolchain`
has already put cargo on `PATH`, so it takes the first branch and execs.

Why `npm test` rather than a longer `vitest run` list: it is the repo's own
entry point and a strict superset of what the step previously did —
`test:prep && typecheck && build && typecheck:tests && vitest run`. `test:prep`
builds the `relayflowd` binary that `tests/live-kernel.test.ts` execs, and the
build is why a bare `vitest run` is the wrong invocation here: several files
fail at collection without `sdk/dist`.

## Local verification

Kernel, the exact command the workflow now runs:

```text
$ cd kernel && sh ../ops/cargo.sh test --workspace
test result: ok. 22 passed; 0 failed; 0 ignored
test result: ok. 34 passed; 0 failed; 0 ignored
test result: ok. 42 passed; 0 failed; 0 ignored
test result: ok. 18 passed; 0 failed; 0 ignored
test result: ok. 5 passed; 0 failed; 0 ignored
test result: ok. 4 passed; 0 failed; 0 ignored
test result: ok. 3 passed; 0 failed; 0 ignored
test result: ok. 1 passed; 0 failed; 0 ignored
test result: ok. 1 passed; 0 failed; 0 ignored
(+ 4 empty targets)
```

130 passed, 0 failed.

SDK, full suite:

```text
$ cd sdk && ./node_modules/.bin/vitest run
Test Files  1 failed | 23 passed | 1 skipped (25)
     Tests  437 passed | 30 skipped (467)
```

The one failed file was `tests/live-kernel.test.ts`, and the cause was in the
harness, not the tree: that run had `RELAYFLOWD_BIN` exported to a path built
from a failed `cargo metadata` parse (`/debug/relayflowd`). Re-run correctly,
and then re-run again with the variable unset — which is the condition CI
actually runs under, where `test:prep` builds the binary and
`locateRelayflowd()` finds it:

```text
$ RELAYFLOWD_BIN=<real path> ./node_modules/.bin/vitest run tests/live-kernel.test.ts
Test Files  1 passed (1)
     Tests  27 passed (27)

$ env -u RELAYFLOWD_BIN ./node_modules/.bin/vitest run tests/live-kernel.test.ts
Test Files  1 passed (1)
     Tests  27 passed (27)
```

So the SDK suite is 464 passed, 30 skipped, 0 failed, and `live-kernel` self-
locates its binary without an environment variable.

## `--locked` was considered and not used

The test step omits `--locked` while the neighbouring build step has it. This
is deliberate and is the command that was actually verified above. Lockfile
drift is still caught, by that adjacent `cargo build --locked --release`.
`cargo test --workspace` also left `Cargo.lock` untouched (`git status
--porcelain` reported only the workflow file), which is the evidence that
`--locked` would have passed — but the step ships as the command with test
counts behind it rather than one inferred to be equivalent.

## Expected effect on CI

Both suites are green locally at this base, so this should not turn CI red. If
it does, the failure is real and pre-existing — it was simply never executed —
and per the work package the correct response is to report it, not to weaken
the workflow or fix the test in this PR.

The marginal cost is the test run itself; the toolchain install, the kernel
build, and `npm ci` were already paid for.
