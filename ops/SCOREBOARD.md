# Gate scoreboard — flows

Every row starts RED and moves only on evidence. AMBER blocks nothing here
(there is no flip) but must resolve before its gate is called closed.

| Gate | State | Evidence |
|---|---|---|
| 1 — a relayflow can run | **GREEN** | Closed by PR #8 (`9e1d9eb`), extended through the live authored run/resume seam by PR #12 (`e48631d`), and given a deterministic watch-registration race regression by PR #48 (`2dfc1fe`). The SDK agent executor merged in PR #53 (`9681f11`). Residual effect-boundary limitations remain documented in `kernel/DESIGN.md`; they do not change this row's state. |
| 2 — proactive agent | **AMBER** | PRs #14 (`2ac0d50`) / #15 (`079f7c4`) landed event wake, wake-context journaling, and duplicate-event suppression; both tests submit the same event twice and assert the duplicate creates no run. PR #120 (`201542a`) added unattended `flows hn-monitor start`; PR #121 (`5835cba`) captured its real-HN live evidence. PR #122 (`a774d88`) closed trigger-plane liveness. PRs #124 (`3855099`) / #125 (`7b115bd`) promote schema-shaped CLI output and carry the triggering payload through `RELAYFLOW_WAKE_CONTEXT` to the dispatched CLI, with positive and negative live-kernel tests. **Remaining:** the canonical `analyze-story` step still declares no real CLI, and PR #121 records every analyzer attempt as `worker_error`; a real authenticated analyzer must reach `done` before a GREEN proposal. |
| 3 — Software Garden | **AMBER** | PR #20 (`5ed2c2f`) added the deterministic backlog picker. PR #123 (`c3ee4eb`) added the three-lens pre-swarm relayflow, and PR #126 (`7728565`) added a concurrent Claude authoring driver over `ops/factory/queue.md`. These are scaffolding: the current factory still uses a markdown queue and hand-rolled shell claims, not kernel leases/claims/retries, so the RFC-0001 Garden done-when remains open. |
| 4 — chief / harness | RED | not started |
| 5 — memory | RED | scoped by harness directive 3 (relayfile + relayhistory per customer) |
| 6 — integrations via relayfile | RED | **BLOCKED on gates 2-4** (Khaliq, 2026-08-28, option B — this repo has no example flows to convert; helper surface may be built now but does not make the gate green) — harness (design partner) needs slack/notion helpers; also unblocks its `REPLACE-WHEN: gate-2` shims |
| 7 — sandbox routing | RED | regression suite needs darwin-arm64 placement |
| 8 — identity + credentials | RED | regression suite needs multi-principal runs |
| 9 — self-improving agents | RED | depends on 5 + 8 |
