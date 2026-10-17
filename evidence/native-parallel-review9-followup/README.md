# Review 9 follow-up for #667

Source commit `8f72bb36` fixes the review-9 completed-root resume report. An
active pinned parallel root in an unsafe Node process refuses with diagnostic
kind `unsafe_parallel_runtime`. A completed root returns its journaled result
without dispatching work, even under a preload. The Surface contract now
states this distinction. The unit coverage checks whole-token parsing of the
six harmless flag forms and seven preload forms.

The live RT2-style test starts a certified parallel flow, kills its first CLI
at a stalled child, and resumes under a no-op preload. That active resume
refuses with the new kind and leaves the two completed effects untouched. A
clean resume completes the flow; a later preload resume returns success with
the same effects, showing that the completed root admitted no new work.

Checks ran on macOS against the local `relayflowd` binary; they did not use
Docker. Commands ran from the worktree root:

```sh
npm run typecheck --prefix packages/sdk
npm run typecheck:tests --prefix packages/sdk
npm run build --prefix packages/sdk
(cd packages/sdk && npx vitest run tests/authored-root.test.ts tests/authored-flow-lifecycle-executor.test.ts)
(cd packages/sdk && RELAYFLOWD_BIN="$HOME/.relayflows-toolchain/target/ms-step-secrets/debug/relayflowd" npx vitest run tests/authored-parallel-run-live.test.ts -t 'reports an active parallel resume as an environment refusal and a completed one as done')
```

Typechecks and build passed. The focused unit suite passed 89/89 tests; the
live test passed once. Command output is in the adjacent `.log` files. The
earlier [review-8 evidence](../native-parallel-review9/README.md) remains
pinned to `2116fe8e` and contains the crash/resume, mutation, and timing
matrices; those matrices were not rerun for this follow-up.
