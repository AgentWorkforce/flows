# STATE — ground truth for an assessor with no git history

A cloud sandbox has **no `.git`, no `gh` auth, and no network to GitHub**. An
assessor there cannot run `git log` or `gh pr list`, so it cannot reconstruct
where the program is from history. This file is that answer, in the repo, and
it is authoritative when history is unavailable.

**Keep it current. A stale STATE.md is worse than none:** it does not merely
fail to help, it actively misleads an assessor that cannot check it.

Last updated: 2026-08-29 07:45 UTC, by Khaliq's session, on `main`.

## Where the program is

- **Gate 1 — a relayflow can run: GREEN.** Closed on `main` at `9e1d9eb`
  (PR #8) and extended by PR #12 (`e48631d`), which put the authored surface
  on the live kernel.
- **Gates 2, 3, 4, 5, 7, 8, 9: RED.** Not started.
- **Gate 6 — integrations via relayfile: RED, and BLOCKED on gates 2-4.**
  Khaliq decided this on 2026-08-28 (option B), after the Lead escalated a real
  spec-vs-reality gap: RFC-0001 defines gate 6 as "every integration step in
  the existing example flows ... expresses as mount", but this repo is the new
  kernel skeleton — it has no example flows, no integration primitives and no
  `runner.ts`. Those live in the old engine. Gate 6's done-when therefore could
  not be satisfied here, which is why three runs "assessed gate 6" and none
  produced gate-6 code.
  **Carve-out:** the `f.slack` / `f.notion` HELPER SURFACE may be built here
  now — the design partner needs it and it does not depend on old-engine flows.
  But gate 6 is NOT green until real flows run on it (RFC-0001 §2 rule 2: "a
  gate is green only when the real workload runs on it").
- **Gate 2 — proactive agent: AMBER, in progress, and it is the frontier.**
  First code landed via **PR #14** (`e0f52e1`, merged 2026-08-28 22:01 UTC):
  `kernel/relayflowd/src/engine/wake.rs` (event matching, dedupe claim, journal
  entries), `relayflowd-core/src/event.rs` (Event, pattern matching, dedupe key
  templating), `TriggerSpec` fields, a subscription registry keyed by
  (flow, subscription, key) with claim repair, and the SDK's `event.submit`
  verb plus trigger fields.
  **Both pieces I previously listed as missing are in fact DONE**, and PR #14
  carried them. Verified on `main` at 23:40 UTC, literally:
  `sh ops/cargo.sh test -p relayflowd --test event_wake` ->
  `matching_event_wakes_once_with_fresh_context ... ok` (1 passed). The
  wake-time context assembly is in `engine/wake.rs`; the idempotency proof is
  `kernel/relayflowd/tests/event_wake.rs`.
  **What remains is the RFC's own bar, which is higher than the primitives.**
  RFC-0001 §3 gate 2 is done when a real proactive workload (`hn-monitor` or
  `linear`) runs as a relayflow — not when the kernel can wake on an event.
  Rule 2 governs: a gate is green only when the real workload runs on it.

  **PR #15 (`079f7c4`) took the first step and no more.** It added
  `testdata/hn-monitor.flow.yaml`, its canonical spec, and
  `kernel/relayflowd/tests/hn_monitor_integration.rs`. Verified by hand:
  `flows check` -> `CHECK PASSED`, and the integration test passes inside the
  full workspace run (19+19+1+1+26+5 passed, 0 failed).

  **A real external event HAS now woken it** — see PR #19 above, verified
  against live Hacker News with exactly-once holding across repeated polls.
  Gate 2 stays AMBER only pending Khaliq's read on whether a manually-invoked
  poller satisfies "runs as a relayflow" under rule 2, or whether it must be
  scheduled and unattended first. That is a judgement, not a missing part.

## Open PRs

**Three are OPEN and awaiting Khaliq.** Do not duplicate this work:

- **#18 — gate 1 race fix** (`kernel/relayflowd/src/server.rs`). Takes the run
  lock so an append's journal commit and hub notification are atomic with
  respect to registration. Kernel suite green. **Caveat on the PR:** its
  regression test was never observed to FAIL without the fix, so the fix is
  sound by reasoning but unproven against the bug.
- **#19 — gate 2 demo** (`sdk/src/demo-hn-monitor.ts`). **Verified against live
  Hacker News:** real story ids woke the flow (`deduped=false wake=created`),
  and a second run of the same stories was refused (`deduped=true wake=none`).
  That is exactly-once holding on real external data.
- **#20 — gate 3 first step** (`testdata/backlog-picker.flow.yaml` + canonical
  spec). A flow that reads the backlog and emits a work package — the seed of
  flows proposing their own next task. `flows check` passes; sdk 153/153.

Merged to date: #1–#8, #10, #12, #13, #14, #15, #16.
PR #9 and PR #11 were superseded by #12 and are closed, not pending.

- **#13** delivered the first cloud-produced work back as a PR.
- **#14** delivered the first gate-2 kernel code, and its four P1 review
  findings were fixed before merge (dedupe namespacing, claim repair for the
  exactly-once path, SDK trigger fields, the `event.submit` verb).

If you are an assessor and `ops/NEXT.md` describes WP-12 (repairing PR #9),
that file is **stale** — #9 no longer exists as open work. Write a new
`ops/NEXT.md` for gate 6 rather than affirming the old one.

## Known environment faults in a cloud sandbox

These are understood, filed, and are NOT reasons to block:

1. **No `.git`, no `gh`.** `sync` runs in `SYNC_MODE=snapshot`: the uploaded
   tree is committed as its own base. `git log` shows one commit; that is
   correct, not damage.
2. **The exec bit is not preserved.** `ops/cargo.sh` arrives non-executable
   and `node_modules/.bin` entries fail with `EACCES`. Observed three times
   independently (run 4cf36ea7, esbuild on 909e18f6, and the Lead's own
   assessment on 54ebd998). The `verify` step invokes scripts via `sh` and
   chmods after `npm ci`; if you hit it elsewhere, do the same.
3. **A sandbox cannot deliver.** No remote, no GitHub token. Work is committed
   in the sandbox and recovered with `agent-relay cloud sync <runId>`.

## What a blocked assessor should do

If genuinely blocked on a decision only a human can make, write
`ops/NEEDS_HUMAN.md` with the exact question and the options — then still end
with `ASSESS_DONE`. The `assess-gate` step reads that file and parks the run
with a typed outcome. Ending with a different token scores as a crash and
burns the retry budget, which is what happened on run 54ebd998.
