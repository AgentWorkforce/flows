# Issue #511: a named gate that fails before its command now says why

Every transcript here is captured output, redirected to the file by the command
it records. Each begins with the literal invocation and ends with its exit
status. The checkout is Linux x64; the reported incident was macOS arm64 and is
not reproduced by any of these runs.

Common preamble for every run: `RELAYFLOWD_BIN` is passed explicitly because
`npm run test:prep` exports it inside a subshell that never reaches vitest. The
literal value is
`/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd` —
the kernel target lives outside the tree because `ops/cargo.sh` redirects
`CARGO_TARGET_DIR`. Revisions: head `f308f95`, parent `e21caad`.

- `head-focused.txt` — the two new files at head: 22 passed, exit 0.
- `mutation-reverted.txt` — mutation verification, red half.
  `git checkout e21caad -- src/named-gate-lowering.ts` reverts the only
  production file; blob hashes before and after the revert are recorded against
  `git rev-parse` of both revisions. Rebuilt, re-run: 13 failed, 9 passed.
  The 9 are stream-capture cases that already passed before the change.
- `mutation-restored.txt` — green half. `git checkout HEAD --` restores;
  `git hash-object` equals `git rev-parse HEAD:…`
  (`8a4ac50391d95c95693eb20cdbc69869a5d02060`) and
  `git status --porcelain` is empty, so the restore is byte-for-byte. Rebuilt,
  re-run: 22 passed, exit 0.
- `head-package-test.txt` — the required package command, `npm test` from
  `packages/sdk`: kernel build, typecheck, build, test typecheck, then vitest.
  Complete output including every failure. `Test Files 3 failed | 155 passed |
  1 skipped (159)`, `Tests 30 failed | 2393 passed | 17 skipped (2440)`,
  exit 1. The package is not green in this sandbox.
- `head-isolated-three-files.txt` — the three failing files alone at head:
  30 failed, 23 passed, 14 skipped.
- `baseline-in-place-e21caad.txt` — the same three files in the same working
  directory with `packages/sdk` reverted to `e21caad`
  (`git diff --stat e21caad -- packages/sdk` empty, the two added test files
  removed). Identical result: 30 failed, 23 passed, 14 skipped, same cases,
  same line numbers. This is the baseline behind the claim that those failures
  are pre-existing; the revision is the only variable between it and
  `head-isolated-three-files.txt`.
- `restore-identity.txt` — restoring the tree after that baseline.
  `git status --porcelain -- packages/sdk` empty and all four changed blobs
  hash-identical to `HEAD`.
- `unrelated-failure-cause.txt` — why 22 of those failures happen here: node
  resolves `@relayflows/surface` to two different installs, one inside the
  checkout and one in an ancestor directory of it
  (`/home/daytona/.relayflow-v2-supervisor/durable/node_modules`), so the
  handle the workflow creates is absent from the `WeakMap` the test's copy of
  `getFlowDefinition` consults (`packages/surface/src/flow.ts:137-143`). A
  sandbox layout defect, not a code one.
- `baseline-e21caad.txt` — the same three files at `e21caad` in a separate
  `git worktree` under `/tmp` with `node_modules` symlinked. Reported for
  completeness and **not** used as the baseline: only 1 failed there, because
  `/tmp` has no ancestor `@relayflows` install, which changes the resolution
  above. The worktree has since been removed. `baseline-in-place-e21caad.txt`
  is the comparison that holds the environment fixed.

Not run: the Rust suite (no kernel code changed) and any Cloud runner-log
publication, whose producer does not exist in this repository. Nothing here
demonstrates the `flows logs <run-id>` acceptance item; `summary.md` records it
as unmet.
