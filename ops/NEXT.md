# NEXT — WP-11: repair PR #9 under review before anything else

Written by the Relayflow Lead on 2026-08-28, assessing at `615f97d`
(`flow/drive-615f97d-08280219`); `origin/main` is `173423c`.

## Why this and nothing else

`ops/DIRECTIVES.md` carries no standing directive, so the backlog governs —
but the backlog does not get a turn. **PR #9 is open with four untriaged
reviewer findings at HEAD `f435545`, three of them P1.** The operating rule is
explicit: no new work over unfinished work. WP-11 is the repair of PR #9.

I read all four findings against the code at `f435545` and **confirmed every
one**. They are not bot noise. Two of them break the surface the PR exists to
ship: as merged today, `flows run` reports a protocol error for any flow that
successfully dispatches to a live worker, and for any run lasting longer than
30 seconds.

There is also **no adversarial review transcript for PR #9** under
`ops/reviews/` — the newest entries are `20260828-0127-cloud-execution.md` and
the PR #8 rounds. The tick's own gate has not run on this PR. Per
`ops/RUN-CONTRACT.md` §3.3, that alone disqualifies it from the merge bar,
independent of the findings.

## Current state, verified now (not carried from a report)

Both suites are green at the assess head `615f97d`:

```text
$ (cd sdk && npm test)
 Test Files  8 passed (8)
      Tests  131 passed (131)

$ (cd kernel && ../ops/cargo.sh test --workspace)
test result: ok. 18 passed; 0 failed; ...
test result: ok. 0 passed; 0 failed; ...
test result: ok. 19 passed; 0 failed; ...
test result: ok. 26 passed; 0 failed; ...
test result: ok. 3 passed; 0 failed; ...
test result: ok. 6 passed; 0 failed; ...
```

That is 72 kernel tests and 131 SDK tests on the tick head. PR #9 claims 73
kernel (a new `spec_parity` case) and adds `sdk/tests/live-kernel.test.ts`.

PR #9 mechanics: `MERGEABLE` / `CLEAN`, CodeRabbit and Devin checks `SUCCESS`.
Per RUN-CONTRACT §3.1 those green checks are **not** review signal — CodeRabbit
posted only a run-configuration summary and Devin produced no findings. The
only substantive external review is Codex's, and it is the four findings below.
The branch is **6 commits behind `origin/main`** (`8c7285b`, `0edbe99`,
`96c3abb`, `0dac7d2`, `615f97d`, `173423c`).

## Objective

Bring PR #9 to a state that genuinely meets `ops/RUN-CONTRACT.md` §3: every
inline finding fixed or refused-with-reasoning **at HEAD**, each with a reply
recording the audit; the branch rebased onto current `main`; the full DoD
re-run on the rebased head; and an adversarial review transcript on disk.

## The four findings, as I verified them

**F1 (P1) — `flows run` dies at 30 seconds.** `sdk/src/cli/run.ts:65` awaits
`client.runStart(spec)` as a single request. `sdk/src/journal-client.ts:49`
sets `requestTimeoutMs = options.requestTimeoutMs ?? 30_000`, and `run.start`
does not return until the daemon has driven the run to a terminal or parked
state. Two sequential 20-second deterministic steps are each individually
valid and make `flows run` reject after 30s with `protocol_error` while
`relayflowd` keeps driving the journaled run to completion. The CLI reports a
failure for a run that succeeds — the exact inversion of "report honestly."
Fix by giving the run lifecycle a lifecycle-appropriate (or absent) timeout,
or by submitting and following `run.watch`; a bare timeout bump is not a fix,
because any constant is wrong for a durable-timer flow.

**F2 (P1) — a successful dispatch is reported as a protocol error.**
`kernel/relayflowd/src/engine/drive.rs:120-138` returns
`RunStatus::Parked` after dispatch *whether or not a worker took the step* —
the registry row distinguishes them (`waiting_worker` vs `parked`), the wire
outcome does not. `findParkedStep` (`sdk/src/cli/run.ts:168`) then looks for a
step whose `run.get` state is `Runnable`; a dispatched step is `Running`, so
no step matches, and `classifyOutcome` falls through to `protocolFailure`.
Every CLI-started flow that reaches a live `llm` or `agent` worker is reported
as a protocol error.
*The repo already contains the correct answer to copy:*
`kernel/relayflowd/src/server/client.rs:98` handles a `Parked` outcome by
consulting the registry and branching on `waiting_worker` (keep following the
lease) versus `parked` (nothing is coming). The TypeScript surface needs the
same distinction. **It must not read the sqlite registry** — AGENTS.md rule 3
makes the journal protocol the boundary. `RunGetResult.steps` is already
`Record<string, string>` and carries `Running`, so this is expressible over the
existing protocol with no wire change: an out-of-band step in `Running` is
"waiting on a worker," not "parked with nothing coming."

**F3 (P1) — the crash-recovery test injects no crash.**
`sdk/tests/live-kernel.test.ts:281` names itself "surface resume after a real
daemon kill," but the run is interrupted by a *separate*
`relayflowd run --stop-after 1` process that exits cleanly (the test asserts
`status === 0` and `initial.status === 'interrupted'`). Only then is
`firstDaemon` spawned, and it does nothing but read the already-finished
journal before being SIGKILLed. Killing an idle daemon interrupts no step and
no boundary; the test passes whether or not socket-started crash recovery
works. This is the "a gate that runs nothing fails" family (RUN-CONTRACT §4)
and it sits directly on gate 1's done-when. Fix: start the run through the
daemon that gets killed, and inject `SIGKILL` while that run is genuinely
mid-flight.
*Calibration, stated so the fix is not oversold:* the underlying property is
already covered kernel-side by
`sigkill_under_serve_resumes_the_socket_started_run`. What is unproven is the
**CLI surface** claim this test makes. Fix the test; do not claim it uncovered
a kernel regression.

**F4 (P2) — `run_unavailable` is asserted about errors it cannot see.**
`resumeFlow`'s catch (`sdk/src/cli/run.ts:86`) maps *every* `run.resume`
rejection to exit 2 / `run_unavailable`. `docs/SURFACE.md:134` defines exit 2
as "refused **before a journal write**." A request timeout, a dropped socket,
or a daemon `journal_write_failed` after resume processing began all now tell
automation that nothing ran when the journal may already have changed. Two
things must land together:
1. `JournalClient` currently **discards the structured code** — line 109
   rejects with `new Error(\`${res.error.code}: ${res.error.message}\`)`. It
   must reject with a typed error carrying `code`, or classification is
   impossible by construction.
2. The kernel has **no `run_not_found` code**. `server.rs` maps an unknown run
   on `run.resume` through `internal_error` → `internal`
   (`kernel/relayflowd/src/server.rs:166-179`, `:438-448`); the closed set is
   `bad_request`, `protocol_mismatch`, `invalid_spec`, `unsupported_verb`,
   `lease_conflict`, `journal_write_failed`, `internal`. So "this run does not
   exist" is presently indistinguishable from "something broke." Introducing a
   typed `run_not_found` is **in scope** — gate 1's done-when requires the
   failure taxonomy to be closed and to "never [terminate in] a raw error,"
   and `internal` for a missing run is exactly the raw error it forbids.
   Transport and runtime errors then route through `protocolFailure`.

## Files in scope

- `sdk/src/cli/run.ts` — F1, F2, F4 classification.
- `sdk/src/journal-client.ts` — F1 timeout policy; F4 typed protocol error.
- `sdk/src/failure-kinds.ts` — only if F2/F4 add a kind to `RUN_FAILURE_KINDS`.
- `sdk/tests/live-kernel.test.ts` — F3; plus new live coverage for F1 and F2.
- `sdk/tests/cli.test.ts`, `sdk/tests/journal-client-loopback.ts` — unit-level
  coverage for the new classification and the typed error.
- `kernel/relayflowd/src/server.rs` — F4 only: a typed `run_not_found`.
- `docs/SURFACE.md` — reconcile the exit-code table with what the code now
  does. If a documented meaning and the code disagree after the fixes, the
  document is wrong until proven otherwise.
- `ops/DRIVE-LOG.md`, `ops/reviews/` — evidence.

## Definition of done

Every command below runs on the **rebased** head and its literal output is
captured (AGENTS.md, "evidence is captured, not narrated" — paste the output,
not a summary of it).

1. Rebase `flow/drive-77b2457-08280058` onto `origin/main` (`173423c` or
   later) in a scratch worktree — RUN-CONTRACT §4: the tick owns its checkout
   and all other repo operations go elsewhere.
2. Each of F1–F4 has a test that **fails before the fix and passes after**.
   For F2 and F3 this is mandatory and mechanical: F2 needs a live worker
   attached while `flows run` starts the flow; F3 needs the kill to land on
   the daemon actually driving the run. Mutation verification has one meaning
   here (AGENTS.md §2) — revert, capture the failure, restore byte-for-byte,
   capture the pass, paste both.
3. Build first, then test — `sdk/tests/live-kernel.test.ts` hard-fails in
   `beforeAll` if either binary is missing, so ordering is load-bearing:
   ```
   (cd kernel && ../ops/cargo.sh build)
   (cd sdk && npm ci && npm run build)
   ```
4. `(cd kernel && ../ops/cargo.sh test --workspace)` — 0 failed. Report the
   new total; do not restate 72 or 73 without reproducing it.
5. `(cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings)` — exit 0.
6. `(cd kernel && ../ops/cargo.sh fmt --check)` — exit 0, empty output.
7. `(cd sdk && npm test)` — 0 failed, `live-kernel.test.ts` among the files
   that **ran** (a skipped live suite is a failed DoD, not a pass).
8. `git status --porcelain` — empty, before and after.
9. Each of the four Codex comments receives a **reply on the PR at HEAD**
   naming the fixing commit, or an explicit reasoned refusal. Never silently
   waved, never silently dismissed (RUN-CONTRACT §3.2).
10. An adversarial review transcript lands in `ops/reviews/` naming the
    reviewed SHA and ending in a verdict token. PR #9 currently has none.
11. `ops/DRIVE-LOG.md` carries this tick's literal transcript, including any
    failure. A tick that fails verification opens no PR and logs the failure.

Merging is governed by RUN-CONTRACT §3 and is **not** part of this package's
done: if the full bar holds after the above, the merge is permitted under the
§2 grant; if any clause is short, PR #9 stays open with the reason recorded.

## Explicitly OUT of scope for this tick

- **Any gate 2–9 work**, including gate 6 integrations, even though the
  scoreboard marks gate 6 "next up." PR #9 is unfinished work; gate 6 waits.
- **Every backlog item**, specifically: the deterministic-command preflight
  gap, the release pipeline, the `steps: []` asymmetry, `f.browser`, the
  regression suite, and the cloud-schedule re-registration.
- **The cloud sandbox verify gaps** (`ops/cargo.sh` losing its exec bit,
  absent `node_modules`) filed at `615f97d`. Real and blocking for unattended
  cloud ticks — and still not this tick.
- **The eight findings carried from PR #8** at squash. They stay in
  `ops/BACKLOG.md`; do not fold them into this branch.
- **Any new product surface on PR #9.** Repair only. A feature added during a
  review-repair round restarts the review and is how a PR stops converging.
- **Editing `docs/RFC-0001`** or `ops/DIRECTIVES.md` — Khaliq's, by PR.

## One inconsistency, flagged not silently resolved

`charter/LEAD.md` says "**You never merge.** You open PRs and report."
`ops/RUN-CONTRACT.md` §2 records a later verbatim grant from Khaliq —
"u have permissions to merge moving forward if all green and pr feedback is
addressed" — and §3 defines the bar. I am treating the later explicit grant as
operative and the charter line as stale text. This is not blocking and needs
no answer to proceed; it should be settled in the charter by PR when
convenient, so the two documents stop contradicting each other.

## Assessment note on stale state

`ops/NEXT.md` as it stood on `main` described WP-9 and PR #8 as open. PR #8
merged at `9e1d9eb` on 2026-08-28 and gate 1 is GREEN on the scoreboard. This
file replaces that handoff. `ops/DRIVE-LOG.md` on `main` likewise ends on the
WP-9 entry; the WP-10 entry exists only on PR #9's branch and reaches `main`
when #9 does.

END_ASSESSMENT
