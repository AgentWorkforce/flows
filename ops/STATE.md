# STATE — ground truth for an assessor with no git history

A cloud sandbox has **no `.git`, no `gh` auth, and no network to GitHub**. An
assessor there cannot run `git log` or `gh pr list`, so it cannot reconstruct
where the program is from history. This file is that answer, in the repo, and
it is authoritative when history is unavailable.

**Keep it current. A stale STATE.md is worse than none:** it does not merely
fail to help, it actively misleads an assessor that cannot check it.

Last updated: 2026-09-01 10:16 UTC, by the Relayflow Lead (flows-lead-1 on sf-mini), on `main`. **STATE.md gate-2 block rewritten; verdict unchanged (still AMBER).** A new evidence file — `ops/reviews/20260901-1050-gate2-live-run.md` — is cited from the gate-2 block; AMBER→GREEN is Khaliq's read on the enclosed evidence.

## Where the program is

- **Gate 1 — a relayflow can run: GREEN, asterisk now CLOSED (PR #48).**
  Closed on `9e1d9eb` (PR #8), extended by PR #12 (`e48631d`). PR #18 fixed a
  real race in watch registration but its regression test had never been
  observed to fail — it rested on a 100ms `recv_timeout`, a scheduling race that
  could pass without the fix and fail spuriously with it.
  PR #48 rewrote it around the `after_ready` seam (`server.rs:427`) using
  rendezvous channels instead of elapsed time. Verified by mutation:
      PR #18 reverted locally -> FAILED. 18 passed; 1 failed
      fix restored           -> ok. 19 passed; 0 failed
      repeated              -> passed 20 / failed 0 out of 20
  Gate 1 no longer carries a fix-on-trust.
- **Gates 2, 3, 4, 5, 7, 8, 9: RED / AMBER as noted.** Gate 2 is AMBER (see block below); the rest are RED / not started.
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
- **Gate 2 — proactive agent: AMBER, unattended trigger-plane proven, two clauses remain.**
  The primitives are all landed:
  - PR #14 (`e0f52e1`) — kernel wake, event matching, dedupe claim, `event.submit`.
  - PR #15 (`079f7c4`) — `testdata/hn-monitor.flow.yaml` + integration test.
  - PR #19 — live-HN → wake, exactly-once.
  - PR #95 — `dir-watcher` poller (2nd workload primitive, non-provider).
  - PR #120 (`201542a`, merged 2026-09-01 08:29 UTC) —
    **`flows hn-monitor start`**, the CLI runner that turns the poller
    into an unattended process.

  **New evidence:** `ops/reviews/20260901-1050-gate2-live-run.md` records a
  live, unattended run of `flows hn-monitor start` against a local
  `relayflowd serve`, driven by real Hacker News top-stories. Real story
  IDs matched, deduped, dispatched under lease, and closed out with typed
  `completionReason` — the full trigger → subscription → dispatch →
  typed-failure loop journalled end to end. Counts, timings, ULIDs, and
  one run's full journal are literal in that file — cite it directly
  rather than restating specific numbers here (STATE.md counts drift, an
  evidence transcript does not).

  **Why AMBER, not GREEN.** RFC-0001 §3 gate 2 has two clauses this
  evidence does NOT close:
  1. **Trigger plane liveness-checked** (RFC-0001 §3 gate 2, the paragraph
     ending "Native's silent-death problem"). RelayCron's deterministic-id
     single-winner claim + `stale_after` sweep is the pattern. Not
     implemented inside `relayflowd`. The poller runs; the kernel does not
     yet notice if it stops. The same section calls this "a requirement,
     not an option" — it is a stated done-when clause, not follow-up
     hardening.
  2. **The analyze-agent step actually executing.** In the recorded run,
     every step ended in `worker_error` because `hn-monitor start`'s
     AgentWorker has no user-supplied step handler. The dispatch loop
     works; the analyzer does not. Whether this reads as gate-2 scope
     ("runs succeed") or gate-4 scope ("chief-as-relayflow supplies
     the runtime") is Khaliq's call.

  **AMBER → GREEN is Khaliq's read** on the enclosed evidence, per this
  block's prior wording ("that is a judgement, not a missing part") and
  per the charter's standing rule that the Lead never merges / never
  flips gates (`ops/AUTONOMY.md` and the "no self-merge" rail; RFC-0001
  covenant 3 governs declared human-in-the-loop *gates within a flow*,
  which is a different thing). This session prepared evidence and left
  the flip pending.

## HANDOFF (2026-08-30 03:05 UTC) — a lead is LIVE on sf-mini

**`flows-lead-1` is running on node `sf-mini`.** Attach with:

    agent-relay node agent attach flows-lead-1 --node sf-mini --mode drive

It carries the full brief: the loop mechanics, the merge rules, and the rules
that were learned the hard way (retarget the brief before its work lands;
measure rather than assert; a guard nothing calls is not a guard; verify by
mutation; `cloud logs --json` because the text form 500s; never cancel a run
because cancel destroys the patch).

**Workspace gotcha that cost an hour:** `sf-mini` lives in the **`default`**
workspace, not the one pinned to this project. `agent-relay fleet nodes` run
from this repo shows only `flows` (the laptop) plus offline `direct-*` records,
and sf-mini looks absent. Pass the default workspace key:

    k=$(agent-relay workspace key default --reveal-secrets)
    agent-relay fleet nodes --all --wk "$k"
    agent-relay fleet spawn claude --node sf-mini --name <name> --wk "$k" --task "..."

`spawn_agent_name_in_use` means a stale registration holds the name — release it
first (`agent-relay fleet release <name> --wk "$k"`), then spawn.

**`ops/autodrive.sh` is STOPPED.** It only ever ran on Khaliq's laptop, which is
closing. Restart it wherever a lead is running:

    cd <repo> && nohup sh ops/autodrive.sh > /tmp/autodrive.log 2>&1 &

**One cloud run was left in flight, unattended:**

    c5c04a7c-dfcb-42cd-890b-e2fa8bad16be   (brief: build a minimal agent worker)

`agent-relay cloud status <id>`; read its log with `--json`; if it produced work
deliver it with `sh ops/deliver-run.sh <id> <clean-checkout>`.

**The cloud workspace 500 is NOT a standing blocker.** `cloud enroll --workspace`
and `fleet spawn --sandbox` failed with 404/500 around 02:50 and both succeed
now. An earlier note here called it server-side and blocking; that was
over-claimed on a single failed attempt.

**Khaliq decided (2026-08-30): the agent worker belongs in THIS repo.** It is the
critical path to gates 2 and 3, and is the current brief.

## Open PRs

**NONE.** Every PR is merged or triaged closed as of 2026-08-30 02:30.

## Merged since 19:00 — do NOT redo any of this

Later additions (2026-08-30):

- **#47** deterministic-command preflight: a path-like command word that does
  not exist REFUSES; a bare word still WARNS. Shell prefixes are not paths —
  `TMPDIR=/tmp printf ok`, `>/tmp/out echo hi` must keep warning, pinned by a
  test. Do not touch preflight.
- **#48** the gate-1 race regression test, rewritten around the `after_ready`
  seam with rendezvous channels instead of a 100ms timeout. Verified by
  mutation: fails against a reverted PR #18, passes restored, 20/20 on repeat.
  **Gate 1 no longer carries a fix-on-trust.**
- **#50** `validateNextWorkPackage` refuses a NEXT.md that cites a path absent
  from the tree, or claims a test passes with no captured output. WIRED INTO
  VERIFY (447a414) — a refusal fails the step. The discriminator between a
  claim and a requirement is MODALITY: "must be green" is a requirement, "all
  three tests pass" is a claim needing a transcript.
- **#51** the actionable-entry test asserts a proportion plus three entries
  pinned BY NAME, not a hardcoded count. A count went stale three times as the
  backlog grew and produced false regressions.
- **#19** the gate-2 HN demo. Reports runs CREATED from live Hacker News and
  honestly declines to claim they EXECUTED, and now states the ordering
  requirement correctly: the worker must attach BEFORE events are submitted,
  because attaching afterwards does not re-drive a parked run.

- **#28** consumer refuses a package scoping files that do not exist
  (`nonexistent_files`), on by default, filesystem call injectable for testing.
- **#30** the backlog flow actually CALLS `validateWorkPackage`; `select-entry`
  scans for the first actionable entry and skips the rest.
- **#34** notes-style titles excluded, imperative titles serve as their own
  definition of done.
- **#35** canonical spec uses the kernel's `depends_on`, not the yaml's
  `dependsOn`. A step added in #30 had reached the kernel with no dependencies,
  no retry policy and no verification.
- **#36** pins the gate-2 dispatch-ordering requirement.
- **#37** the canonical spec is guarded by SHAPE, not just commands, and by the
  dependencies the yaml declares.
- **#38** builds outside the propagated tree (`CARGO_TARGET_DIR` keyed per
  worktree) to shrink the relayfile flush payload.
- **#41, #42** picker actionability: ACTIONABLE 5/32 -> 22/32 against the real
  backlog, target was 20. **This item is CLOSED.** The "Upstream issues" notes
  blob is still correctly refused.

**Closed, not merged — do not resurrect:** #29, #31 (duplicates of #28), #32
(exported a checker nothing called; two of its three refusal reasons were
regressions), #33 (matched one literal entry title), #39 (made the count worse),
#40 (a correct refusal of an impossible target — see below).

## The failure mode that cost the most today

Seven of roughly a dozen drive PRs were closed, and in nearly every case the
brief was at fault, not the run:

- a target measurable by a counter that moved for the wrong reason;
- a target naming a specific entry, satisfiable by a string match;
- a target made unreachable by a constraint added in the same edit — run
  5ecf7078 refused it and filed `ops/NEEDS_HUMAN.md` with a reproduction, which
  was the correct call and better than the three PRs that met the letter of an
  earlier target while changing nothing.

If a run cannot hit a target, check the target is reachable before assuming the
run is at fault.

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
