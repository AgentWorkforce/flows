# Standing human directives

Directives from Khaliq to the Relayflow Lead. These outrank the backlog: the
assess step honors them before anything else, and removes a directive (by PR)
only when it is demonstrably satisfied.

## 2026-09-14 — every feature verifiable, then autonomous merge

Work `ops/VERIFY-FEATURES-PLAN.md` in order: take the first work package
(WP-V1 … WP-V7) whose `blocked-by` are all merged on `main`, or fix an open
PR from an earlier package if review is waiting on it. One package per tick.
Quote the package's definition of done into `ops/NEXT.md`. Satisfied when
WP-V7 is merged and the plan's human steps are recorded done; remove this
directive in that PR.
