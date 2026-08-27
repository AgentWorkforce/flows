# Gate scoreboard — flows

Every row starts RED and moves only on evidence. AMBER blocks nothing here
(there is no flip) but must resolve before its gate is called closed.

| Gate | State | Evidence |
|---|---|---|
| 1 — a relayflow can run | **GREEN** | The premature rung-only GREEN was corrected through AMBER for the missing second clause. WP-4 now closes covenant-2 preflight: `flows check` resolves step → header → `flows.json`, refuses `cli_missing` / `cli_unauthenticated` / `cli_unresolved` / `no_executor`, warns on unprovable effects, and keeps failure kinds closed. All three ladder rungs pass check; kernel 72 tests and SDK 76 tests pass with clippy/fmt clean. Residual documented in DESIGN.md §1.9 remains gate 4 work. |
| 2 — proactive agent | RED | not started; harness shims wait on it |
| 3 — Software Garden | RED | not started |
| 4 — chief / harness | RED | not started |
| 5 — memory | RED | scoped by harness directive 3 (relayfile + relayhistory per customer) |
| 6 — integrations via relayfile | RED | eligible after gate 1; the next assess chooses among gates 2 and 5–8 from current evidence |
| 7 — sandbox routing | RED | regression suite needs darwin-arm64 placement |
| 8 — identity + credentials | RED | regression suite needs multi-principal runs |
| 9 — self-improving agents | RED | depends on 5 + 8 |
