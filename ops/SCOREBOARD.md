# Gate scoreboard — flows

Every row starts RED and moves only on evidence. AMBER blocks nothing here
(there is no flip) but must resolve before its gate is called closed.

| Gate | State | Evidence |
|---|---|---|
| 1 — a relayflow can run | **GREEN** | Closed on `main` at `9e1d9eb` (PR #8, merged by Khaliq). Verified by me on a clean worktree off `origin/main`, not on branch evidence: kernel **72 passed / 0 failed**, sdk **131 passed / 8 files**. Preflight proven behaviorally through the built binary `sdk/dist/cli.js`: `cli_missing`, `cli_unauthenticated`, `cli_unresolved` each REFUSE with exit 2; `hello-ladder` passes with an `unprovable_effects` warning (silence is not a state). Residual, documented in DESIGN.md §1.9: a worker dying after the provider call but before confirming performs an effect twice — closing it needs gate 4's mount-as-writer. |
| 2 — proactive agent | RED | not started; harness shims wait on it |
| 3 — Software Garden | RED | not started |
| 4 — chief / harness | RED | not started |
| 5 — memory | RED | scoped by harness directive 3 (relayfile + relayhistory per customer) |
| 6 — integrations via relayfile | RED | **next up** — harness (design partner) needs slack/notion helpers; also unblocks its `REPLACE-WHEN: gate-2` shims |
| 7 — sandbox routing | RED | regression suite needs darwin-arm64 placement |
| 8 — identity + credentials | RED | regression suite needs multi-principal runs |
| 9 — self-improving agents | RED | depends on 5 + 8 |
