# STATE — ground truth for an assessor with no git history

A cloud sandbox has **no `.git`, no `gh` auth, and no network to GitHub**. An
assessor there cannot run `git log` or `gh pr list`, so it cannot reconstruct
where the program is from history. This file is that answer, in the repo, and
it is authoritative when history is unavailable.

**Keep it current. A stale STATE.md is worse than none:** it does not merely
fail to help, it actively misleads an assessor that cannot check it.

Last updated: 2026-08-28 20:10 UTC, by Khaliq's session, on `main`.

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
- **Gate 2 — proactive agent: RED, and it is NEXT UP.** It is the first of the
  2-4 sequence that gate 6 waits on.

## Open PRs

**None.** Every flows PR opened to date is merged: #1–#8, #10, #12.
PR #9 and PR #11 were superseded by #12 and are closed, not pending.

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
