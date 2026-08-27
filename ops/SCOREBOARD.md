# Gate scoreboard — flows

Every row starts RED and moves only on evidence. AMBER blocks nothing here
(there is no flip) but must resolve before its gate is called closed.

| Gate | State | Evidence |
|---|---|---|
| 1 — a relayflow can run | **AMBER** | *(corrected: I marked this GREEN on the ladder evidence alone; gate 1's done-when has a second clause — `flows check` preflight per covenant 2 — which is unmet. Tick 5's Lead caught it and picked WP-4 accordingly.)* Clause 1 is closed and merged: (a) deterministic #2/#3, (b) llm #4, (c) `agent` + Appendix A #7 (`ca6b80a`). Clause 2 is implemented on the WP-4 branch and **not yet merged**, so the gate remains AMBER. On the merged branch tree, `flows check` resolves step → header → `flows.json`; refuses `cli_missing` / `cli_unauthenticated` / `cli_unresolved` / `no_executor`, each reproduced against all three ladder flows under an induced fault; and never accepts a deterministic step silently — every one leaves `unprovable_effects`, `command_unresolved`, or `command_unprovable`. Measured on this tree: kernel 72 tests, SDK 99 tests, 0 failed, clippy/fmt clean. Flips to GREEN only after a human merges WP-4 and re-verifies it on `main`. Residual documented in DESIGN.md §1.9: a worker dying after the provider call but before confirming performs an effect twice; closing it needs the mount as writer (gate 4). |
| 2 — proactive agent | RED | not started; harness shims wait on it |
| 3 — Software Garden | RED | not started |
| 4 — chief / harness | RED | not started |
| 5 — memory | RED | scoped by harness directive 3 (relayfile + relayhistory per customer) |
| 6 — integrations via relayfile | RED | eligible after gate 1; the next assess chooses among gates 2 and 5–8 from current evidence |
| 7 — sandbox routing | RED | regression suite needs darwin-arm64 placement |
| 8 — identity + credentials | RED | regression suite needs multi-principal runs |
| 9 — self-improving agents | RED | depends on 5 + 8 |
