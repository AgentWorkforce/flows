# Gate scoreboard — flows

Every row starts RED and moves only on evidence. AMBER blocks nothing here
(there is no flip) but must resolve before its gate is called closed.

| Gate | State | Evidence |
|---|---|---|
| 1 — a relayflow can run | **AMBER** | *(corrected: I marked this GREEN on the ladder evidence alone; gate 1's done-when has a second clause — `flows check` preflight per covenant 2 — which is unmet. Tick 5's Lead caught it and picked WP-4 accordingly.)* All three rungs merged: (a) deterministic #2/#3, (b) llm #4, (c) `agent` + Appendix A #7 (`ca6b80a`). Kernel 70 tests, SDK 58, clippy/fmt clean — verified independently, not on the gate's word. Residual documented in DESIGN.md §1.9: a worker dying after the provider call but before confirming performs an effect twice; closing it needs the mount as writer (gate 4). |
| 2 — proactive agent | RED | not started; harness shims wait on it |
| 3 — Software Garden | RED | not started |
| 4 — chief / harness | RED | not started |
| 5 — memory | RED | scoped by harness directive 3 (relayfile + relayhistory per customer) |
| 6 — integrations via relayfile | RED | **next up** — harness (design partner) needs slack/notion helpers; also unblocks its `REPLACE-WHEN: gate-2` shims |
| 7 — sandbox routing | RED | regression suite needs darwin-arm64 placement |
| 8 — identity + credentials | RED | regression suite needs multi-principal runs |
| 9 — self-improving agents | RED | depends on 5 + 8 |
