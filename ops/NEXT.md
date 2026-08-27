# NEXT — single highest-priority work package

Written by the Relayflow Lead (`charter/LEAD.md`) at assess time,
2026-08-27, on `flow/drive-57e923c-08271542` (base `57e923c`).

## Assessment

### Directives — none outstanding

`ops/DIRECTIVES.md` carries its header and **zero active directives**.
Directive 1 ("stay lean", 2026-08-27) was satisfied and removed by PR #3
(`0ba6c88`), which is the documented removal discipline. Nothing in the
directives file outranks the backlog this tick.

### Open PRs — none awaiting fixes; no unfinished work to resume

`gh pr list --state open` returns exactly one PR:

- **PR #6 — `regressions: relaycast workspace-key repair answers an untyped
  500`** (`flows/relaycast-500-regression`), **DRAFT**, MERGEABLE, CodeRabbit
  SUCCESS, Devin Review SUCCESS, `reviewDecision: ""`, `reviews: []`.

The previous tick's log explicitly asked this assess to *decide* whether a
draft PR counts as unfinished work. **Ruling: it does not block, and it is not
this loop's work.** Reasons, recorded so the decision is not re-litigated:

1. It has **no review awaiting fixes** — CodeRabbit deliberately skipped it as
   a draft, Devin passed, no human review is requested. There is no review
   feedback to address, so the "never start new work over unfinished work" rule
   has nothing to bite on.
2. It documents a defect in **another repository** (`relaycast-cloud`
   `packages/relaycast/src/fleet/routes.ts:523` runs its D1 statements with no
   `try`/`catch`). The fix is already filed as **AgentWorkforce/relaycast-cloud#88**.
   No code in this repo can close it.
3. Its author has already recorded, on the PR, that the pair is the suite's
   **first false-green hazard** (the red case stopped reproducing at 18:46Z;
   4/4 repair calls answered 200). It is correctly parked as a draft *because*
   it should not be judged by its exit code yet. Promoting it to ready would be
   the dishonest move, not the diligent one.

It stays a draft. It is not a gate-1 dependency.

### Gate 1 — **its done-when does not hold, and the scoreboard overstates it**

This is the finding that sets this tick's package.

`ops/SCOREBOARD.md` currently reads **GREEN** for gate 1, on the evidence "all
three rungs merged: (a) deterministic #2/#3, (b) llm #4, (c) `agent` +
Appendix A #7 (`ca6b80a`)." That evidence is real and I re-verified it below.
But RFC-0001 §3 gate 1's **done-when has two clauses**, and the flip commit
(`57e923c`) addresses only the first:

> **Done when:** the canonical hello *ladder* — (a) … (b) … (c) … — each
> survives `kill -9` … Budget accounting is exact … **Preflight holds
> (covenant 2):** `flows check` refuses the ladder flows when a declared CLI is
> missing or unauthenticated or a trigger has no executor, warns on unprovable
> assumptions before starting, and the failure taxonomy is closed — every
> failed run's journal terminates in a declared failure kind, never a raw
> error.

**Clause 2 is unsatisfied. `flows check` does not exist.** Verified this tick,
not taken from the prior log:

- No `bin` key in `sdk/package.json` — there is no `flows` executable at all.
- `sdk/src/` is seven files (`canonical`, `compile`, `index`, `journal-client`,
  `protocol`, `spec`, `validate`); no `cli.ts`, no `preflight.ts`.
- No `preflight` symbol anywhere outside `docs/`, `ops/` prose, one Rust
  doc-comment (`kernel/relayflowd/src/engine/drive.rs:279`) and a test name.
- `sdk/src/spec.ts` has **no `cli` declaration** on `AgentStepSpec`
  (`:134-140` is `type`/`instruction`/`surfaces`/`recoveryMode`/`permissions`)
  and **no `triggers`** at root (`ROOT_KEYS` in `validate.ts:43` is
  `version, name, description, steps, budget`). So neither refusal condition
  named in the done-when is even *expressible* in the spec today.

The prior tick's own DRIVE-LOG (`:376-377`) and NEXT.md (`:53-56`, `:201`) both
say this plainly and name the preflight as "the package after this one." The
scoreboard flip landed 26 minutes after that log without citing the clause. Its
"Residual" note discusses only the DESIGN.md §1.9 double-effect window — a
different, correctly-disclosed issue.

**Read this as an accounting error to correct, not a ruling to overturn.** The
commit message argues the rungs, not the preflight; it does not claim clause 2
holds. Correcting the row to AMBER is part of this package. Flagging it for the
human: a gate row is a claim about company progress ahead of the 2026-09-15 YC
presentation, and it should not read GREEN on half its done-when.

Because gate 1's done-when does not hold, **gate 1 is still the current gate**,
and the scoreboard's "gate 6 — **next up**" is premature for the same reason.

### Test status — verified independently this tick, all green

Hermetic `ops/cargo.sh` (no manually exported env), from `main`'s tree at
`57e923c`:

- `cd kernel && ../ops/cargo.sh test --workspace` — **70 passed, 0 failed**,
  exit 0 (18 + 0 + 19 + 24 + 3 + 6 + 0 doc-tests ×3).
- `cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings` — exit 0.
- `cd kernel && ../ops/cargo.sh fmt --check` — exit 0, no output.
- `cd sdk && npm test` — **58 passed, 0 failed**, 5 files, exit 0
  (`deterministic-llm` 5, `validate` 30, `hello-deterministic` 5,
  `journal-client` 12, `spec-parity` 6).

These match the scoreboard's "Kernel 70 tests, SDK 58, clippy/fmt clean."
Clause 1 of the done-when is genuinely closed on `main`. Nothing is red.

### Backlog — nothing outranks the open gate-1 clause

Release pipeline, schedule re-registration, PR-shepherd flow, the harness
design-partner asks, `f.browser`, computer use, the cloud-sandbox git-remote
gap: every one is gate-2-or-later, or below gate 1's needs. None of them close
gate 1. The regression suite is dormant by its own MANIFEST until gates
1/2/6/7/8. Per the charter, the open gate's remaining clause wins.

---

## Work package: WP-4 — `flows check` preflight (covenant 2), gate 1's second done-when clause

### Objective

Make `flows check` real: a CLI that **refuses a flow before any run starts**
for each condition RFC-0001 §3 gate 1 names, **warns** (without refusing) on
assumptions it cannot prove, and emits **only declared failure kinds** — never
a raw error string. When this lands, gate 1's done-when holds in full and the
scoreboard row flips to GREEN on both clauses instead of one.

The three ladder flows in `testdata/` are the subjects: `flows check` must pass
them clean as authored, and refuse each one under an induced fault.

Two spec surfaces have to exist for the done-when's own words to be
expressible, and they are in scope **as data only**, sized to this gate
(AGENTS.md rule 6 — no speculative abstraction):

- **A declared CLI** on agent (and `llm`) steps, so "a declared CLI is missing
  or unauthenticated" has a subject. Resolution follows `docs/SURFACE.md:78`
  order but implements only: step options → flow header → `flows.json`. A
  resolution that runs out of sources **refuses**; it never guesses a platform
  default. "You are told exactly who you hired before the run starts."
- **A declared trigger** at root, so "a trigger has no executor" has a subject.
  **Data and check only** — no matching, no dispatch, no liveness sweep. The
  trigger *plane* is gate 2 and stays there.

### Files in scope

New:
- `sdk/src/cli.ts` — `flows` entrypoint; `check` subcommand only.
- `sdk/src/preflight.ts` — the predicates, pure and injectable (probes passed
  in, so tests never touch a real PATH or network).
- `sdk/src/failure-kinds.ts` — the closed refusal taxonomy.
- `sdk/tests/preflight.test.ts`, `sdk/tests/cli.test.ts`.
- `testdata/preflight/` — fixtures: a flow with a declared CLI, a flow with a
  declared trigger, and the induced-fault variants.

Modified:
- `sdk/src/spec.ts` — `cli` on `AgentStepSpec`/`LlmStepSpec`, flow-header
  default, root `triggers`.
- `sdk/src/validate.ts` — new keys in `ROOT_KEYS` / `STEP_TYPE_KEYS`; still
  fail-closed on unknown keys (the existing discipline at `:39-58`).
- `sdk/src/index.ts` — export `preflight`, the kinds, the new types.
- `sdk/package.json` — `"bin": { "flows": "./dist/cli.js" }`; `build` must run
  before the CLI is invocable.
- `kernel/relayflowd-core/src/spec.rs` — parity for the new fields.
- `testdata/hello-{ladder,llm,agent}.flow.yaml` + their
  `.spec.canonical.json` + `.spec.sha256` — regenerate; `spec-parity.test.ts`
  pins these and will fail loudly if they are not.
- `docs/SURFACE.md` — only if the shipped surface diverges from what §78/§92
  already describe. Prefer conforming to the doc over editing it.
- `ops/SCOREBOARD.md` — gate 1 **GREEN → AMBER** with clause 2 named as the
  reason, in the same PR that then closes it; gate 6's "next up" annotation
  corrected to follow gate 1.
- `ops/BACKLOG.md`, `ops/DRIVE-LOG.md`, `ops/NEXT.md`.

### Definition of done

**Refusals — each must be reproducible from a command, name its kind, and exit non-zero:**

1. `cli_missing` — a step declares a CLI absent from PATH. `flows check`
   refuses **before** any run starts, names the step id and the CLI, exits `2`.
2. `cli_unauthenticated` — the CLI resolves but its auth probe fails. Distinct
   kind, distinct message; never collapsed into `cli_missing` (covenant 1: the
   error names the condition the operator must act on).
3. `cli_unresolved` — no `cli` at step, header, or `flows.json`. Refuses rather
   than guessing a default.
4. `no_executor` — a declared trigger with no registered executor. The kind is
   spelled **`no_executor`** to match what
   `regressions/cron-succeeded-into-void.green.flow.ts:10` already expects, so
   the dormant suite does not need editing when it wakes.

**Warnings — must NOT refuse:** at least one unprovable-assumption warning
(e.g. a `deterministic` command whose binary resolves but whose effects are
unknowable; budget headroom against declared `maxDollars`). Warnings go to
stderr, are marked as warnings, and leave exit `0`. A run that is merely
un-provable is not a run that is refused.

**Taxonomy closure (the clause's last sentence):**

- A test asserts **exhaustively** that every refusal path returns a declared
  kind — no raw `Error.message`, no `unknown`, no stringified exception,
  reaches the operator or the `--json` output.
- A test asserts every failed-run journal terminates in a declared
  `CompletionReason` (`kernel/relayflowd-core/src/entry.rs:159-169`), holding
  the existing kernel-side guarantee against regression.

**Commands that must pass (all exit 0 unless stated), re-run on the PR branch and quoted verbatim in the PR body:**

```
cd kernel && ../ops/cargo.sh test --workspace          # >= 70 passed, 0 failed; no suite shrinks
cd kernel && ../ops/cargo.sh clippy --workspace -- -D warnings
cd kernel && ../ops/cargo.sh fmt --check
cd sdk && npm run build
cd sdk && npm test                                     # >= 58 passed + the new preflight/cli tests, 0 failed
```

Behavioral gate — the ladder flows, clean and under induced fault:

```
node sdk/dist/cli.js check testdata/hello-ladder.flow.yaml   # exit 0
node sdk/dist/cli.js check testdata/hello-llm.flow.yaml      # exit 0
node sdk/dist/cli.js check testdata/hello-agent.flow.yaml    # exit 0
node sdk/dist/cli.js check testdata/preflight/cli-missing.flow.yaml          # exit 2, kind cli_missing
node sdk/dist/cli.js check testdata/preflight/cli-unauthenticated.flow.yaml  # exit 2, kind cli_unauthenticated
node sdk/dist/cli.js check testdata/preflight/no-executor.flow.yaml          # exit 2, kind no_executor
node sdk/dist/cli.js check --json testdata/preflight/cli-missing.flow.yaml | python3 -m json.tool
```

The `--json` output must parse and every entry must carry a declared kind.
Induced faults must come from injected probes or fixture config, **not** from
mutating the developer's PATH — the gate has to run identically on a fresh
machine and in CI.

**Structural:**

- `find kernel -name '*.rs' -not -path '*/target/*' | xargs wc -l` — largest
  file under 500 lines (AGENTS.md rule 1).
- No file in `sdk/src/` over 500 lines (`validate.ts` is already 411 — split it
  rather than growing it past the line).
- A gate that runs nothing is a failure: the PR body states the *executed* test
  counts, not the intent.

### Explicitly OUT of scope for this tick

- **The trigger plane** — matching, dispatch, `EventFrameV1`, schedules,
  liveness sweeping, `stale_after` reconciliation. Gate 2. `triggers:` is
  inert data that `check` reads and nothing executes.
- **`flows run` / `flows build` / `flows deploy`**, content-addressed bundles,
  digests, signing (RFC settled decisions #14, `SURFACE.md:92`). `check` is the
  only subcommand.
- **The v2 `@relayflows/surface` dialect.** `flows check` operates on the YAML
  dialect and compiled specs. Running it against `regressions/*.flow.ts`
  (`regressions/README.md:30`) needs a surface that does not exist; matching
  the `no_executor` kind name is the whole of this tick's obligation there.
- **Real mounts / relayfile adapters** (gate 6); **permission enforcement** —
  `PermissionsSpec` stays data-only (gate 8); **memory scopes** (gate 5).
- **Live agent CLI or model invocations.** Auth probes are injected in tests;
  no provider call anywhere in the gate.
- **PR #6** — draft, upstream fix filed as relaycast-cloud#88. Do not promote,
  do not merge, do not rework.
- **The two residual WP-3 findings** — P2-A (`agent_pins_available` vs
  `worker_holds` disagreement burning one journaled attempt per resume) and
  P3-B (unvalidated `started_pins`/`end_pins` on non-agent completions). Both
  recorded in DRIVE-LOG, neither blocking, both unreachable in the shipped
  rung-(c) flow. Backlog.
- **The DESIGN.md §1.9 at-most-once effect window.** Needs the mount as writer;
  gate 4. Disclosed, not fixed.
- **The cloud-sandbox `origin` gap** and schedule re-registration — real, but
  gate-2/7 adjacent and not a gate-1 clause.
- **RFC or charter edits**, and any history rewrite of the PR #2-era vendored
  blobs (a human decision).

### Known drift this tick will hit — fix the workflow, do not re-instruct the agent

`workflows/drive.yaml`'s `pr` step has produced a branch-name title and a
boilerplate body for **four consecutive ticks**, with the root cause already
pinpointed in DRIVE-LOG: `:126` hardcodes the body string (so verify tails can
never land there), `:124` builds the subject with `grep … | cut -c1-60`, a
*byte* cut that severs the multibyte em-dash, and `:126` calls
`gh pr create --fill`, which falls back to the branch name for the title on
multi-commit branches. (DRIVE-LOG cites this as `:108-115`; that citation is
stale — `:108-115` is the review step. The real lines are `:124` and `:126`.) If the package completes with slack, hardening that
`pr` step is the **first** standing candidate — it is a two-line fix to a
four-tick recurrence. It is not the package itself: gate 1's open clause
outranks process drift.

### Delivery

One PR against `main` from a `flow/` branch. Every commit message names WP-4.
The PR title states the work package name (not the branch). The PR body carries
the five verify tails **verbatim** plus the behavioral-gate outputs above. The
review step must leave its transcript in `ops/reviews/` — if it does not
produce a file, say so in DRIVE-LOG rather than inferring a verdict from
workflow gating. Rebase on `main` before opening, so the local diff and
GitHub's merge-base diff agree.

The Lead does not merge: report and await human review, per the charter's hard
rails.

ASSESS_DONE
