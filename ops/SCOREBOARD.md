# Gate scoreboard — flows

Every row starts RED and moves only on evidence. AMBER blocks nothing here
(there is no flip) but must resolve before its gate is called closed.

| Gate | State | Evidence |
|---|---|---|
| 1 — a relayflow can run | **GREEN** | Closed on `main` at `9e1d9eb` (PR #8, merged by Khaliq) and extended on WP-10 by the live authored-surface seam: the built `sdk/dist/cli.js` submits `hello-deterministic.flow.yaml` to a real `relayflowd`, parks `hello-llm` and `hello-agent` with typed step details, journals `step_failed`, and resumes after `kill -9` with one successful completion per step. Branch verification: kernel **73 passed / 0 failed**, SDK **143 passed / 9 files**, including **7/7** built-binary and **4/4** live-kernel cases. Residual, documented in DESIGN.md §1.9: a worker dying after the provider call but before confirming performs an effect twice — closing it needs gate 4's mount-as-writer. |
| 2 — proactive agent | RED | not started; harness shims wait on it |
| 3 — Software Garden | RED | not started |
| 4 — chief / harness | RED | not started |
| 5 — memory | RED | scoped by harness directive 3 (relayfile + relayhistory per customer) |
| 6 — integrations via relayfile | RED | **next up** — harness (design partner) needs slack/notion helpers; also unblocks its `REPLACE-WHEN: gate-2` shims |
| 7 — sandbox routing | RED | regression suite needs darwin-arm64 placement |
| 8 — identity + credentials | RED | regression suite needs multi-principal runs |
| 9 — self-improving agents | RED | depends on 5 + 8 |
