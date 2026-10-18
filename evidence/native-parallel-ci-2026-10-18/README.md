# #667 Linux artifact CI follow-up

The `linux-x64-artifact` job at `63c9994d` failed one serial-only live test
with `run_admission_conflict` and four `flows check --watch` tests with their
5-second test timeouts. The full job log is in GitHub Actions run
`39043415569`, job `117427280321`.

## Serial arguments-alias test

The arguments-alias LLM fixture is certified **serial** before it is killed.
Its old assertion required every resumed run to exit zero, even though the
serial scheduler can report the existing #674 `run_admission_conflict` when
concurrent branches resume in a different order; this also occurs on
2.0.50/2.0.51. The revised test still requires serial mode, one L and one R
effect, at most one Z effect, and exactly two LLM requests. A nonzero resume
may only be exit 1 with `run_admission_conflict`. No parallel-mode expectation
changed. Its child CLI timeout is now 90 seconds so a slow macOS host does
not produce a null exit status after the fixture's former 30-second limit.

`npm run typecheck:tests` passed. A focused six-repetition macOS run reached
the test's 240-second limit; it did not provide a result for the revised
assertions. The new Linux CI run is the required rerun of that live fixture.

## Watch timeout comparison

The watch test and its direct implementation files are byte-identical at
`origin/main` (`5de41849`, Flows 2.0.51) and this PR head. The comparison
included `cli-watch.ts`, `dir-watcher-poller.ts`, `cli/check.ts`,
`cli/check-typescript.ts`, and `cli-watch.test.ts`; `git diff --name-only`
returned no paths and both test blobs are `b43c7966f32a9369fcf0bb0bd57d19aa73f490a3`.

In an isolated main worktree, a focused rerun of the four CI timeout cases
timed out on the transitive-import and missing-import cases at 5 seconds;
the nearer-config and delete/recreate cases passed. A branch rerun of all 11
watch tests passed nine and timed out on two cases. Raising only Vitest's
outer test timeout to 20 seconds still left two failures at the test's inner
5-second `expect.poll` deadline. The changing cases and unchanged watch code
show a pre-existing timing sensitivity, outside the parallel scheduler.
Watch code and assertions were left untouched.

Local comparison commands used Node 26.11.1 and Bun 1.4.2 on macOS:

```sh
git diff --name-only origin/main HEAD -- packages/sdk/tests/cli-watch.test.ts packages/sdk/src/cli-watch.ts packages/sdk/src/dir-watcher-poller.ts packages/sdk/src/cli/check.ts packages/sdk/src/cli/check-typescript.ts
(cd ../main-control/packages/sdk && npx vitest run tests/cli-watch.test.ts -t 'watches transitive|refreshes the import graph|detects a nearer config|keeps watching after')
(cd flows-parallel/packages/sdk && npx vitest run tests/cli-watch.test.ts --testTimeout=20000)
```

The adjacent logs are the local main and branch reruns. GitHub Actions uses
Node 22.23.3 and Bun 1.4.0, so the new CI job remains the Linux check.
