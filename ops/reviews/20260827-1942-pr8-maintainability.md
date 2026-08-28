# PR #8 — WP-4 `flows check` preflight (covenant 2) — maintainability review

- **Lens:** maintainability — could a stranger read this in six months and change it safely?
- **PR:** `flow/drive-57e923c-08271542` → https://github.com/AgentWorkforce/flows/pull/8
- **Reviewed tree:** `e074a92380c13564ca68ac3c7b319e639a7e9163`
- **Artifacts:** `/tmp/pr-8.diff` (9,193 lines, 60 files), `/tmp/pr-8.json`
- **Read first:** `AGENTS.md`, `docs/RFC-0001-everything-is-a-relayflow.md`

## Verification actually performed

Every claim below is backed by a command I ran on this tree, not by reading alone.

- `cd sdk && npm test` (`tsc --noEmit` + vitest): **120 passed, 0 failed**, 7 files.
- `cd kernel && CARGO_HOME=/tmp/rev-cargo-home cargo test`: **72 passed, 0 failed**
  (18 + 19 + 26 + 3 + 6 across the five suites). The prior round could not run these
  because of a `~/.cargo` registry-state fault; overriding `CARGO_HOME` cleared it, so
  the Rust half of this PR is now executed, not merely read.
- **Mutation probes** (3), each applied, run, and reverted with a verified-clean
  `git status`:
  1. Deleted the flow-`cli` and trigger validation block from `RunSpec::validate`
     (`kernel/relayflowd-core/src/spec.rs:69-81`) → **72/72 kernel tests still pass.**
  2. Neutered the duplicate-trigger-id branch in `sdk/src/validate.ts:180` →
     **120/120 SDK tests still pass.**
  3. Deleted the `try`/`catch` from `probeTrigger` in `sdk/src/preflight.ts:147-163` →
     **120/120 SDK tests still pass.**
- **Behavioural probes** against throwaway directories, each with its own `flows.json`
  boundary so no ambient config could leak in:
  - a mode-644 (present, non-executable) CLI file → observed output recorded in F4;
  - a 5-step flow sharing one flow-level `cli`, with a logging fixture CLI → observed
    probe count recorded in F5.
- **Packaging probe:** `npm run build` then `node dist/cli.js check
  ../testdata/hello-ladder.flow.yaml` → shebang preserved, exit 0, correct output.
- Confirmed `workflows/` and `.github/` are **byte-identical to `origin/main`** on this
  branch (`git diff --stat origin/main...HEAD -- workflows/ .github/` is empty). The
  self-judging-gate finding raised in the 19:24 round is **closed**.

## What is good, and should survive any rewrite

- **Preflight is pure and the purity is documented.** `PreflightProbes` injects every
  environment fact; the module doc states the contract in three sentences. That single
  decision is why the entire refusal taxonomy is enumerable in a 122-line unit test with
  zero filesystem access. Keep it.
- **Every new file is small** (AGENTS.md rule 1): `preflight.ts` 237, `cli.ts` 282,
  `failure-kinds.ts` 43. Nothing near the 500-line smell.
- **The taxonomy is closed, split, and honestly scoped.** `failure-kinds.ts` separates
  input refusals from preflight refusals, and `preflight.test.ts:102-107` explicitly
  records that the test proves *reachability* while the *converse* is held by
  `tsc --noEmit`. Telling a future reader which guarantee comes from where — instead of
  letting them assume the test proves both — is the rarest thing in this diff.
- **The ladder-fault tests carry a control.** `cli.test.ts:135-141` relocates each
  canonical flow *without* inducing a fault and asserts it still passes, so the induced
  refusals cannot be an artifact of the temp directory. That control is the difference
  between green and meaningful.
- **The JSON report is pinned whole** (`cli.test.ts:186-217`), so a field silently
  appearing or vanishing from `CheckReport` breaks a test.
- **`kernelDialectMarker` names its own ambiguity** in a comment and reports the exact
  key that triggered the routing decision back to the author. Good instinct on a
  heuristic that would otherwise be a six-month mystery.

---

## Blocking findings

### M1 — Three of the four new kernel `SpecError` variants are pinned by nothing

`RunSpec::validate` gained three rules in this PR (`spec.rs:69-81`): `EmptyCli`,
`InvalidTrigger`, `DuplicateTrigger`. Only `EmptyStepCli` — the fourth — is asserted, in
`spec/tests.rs:preflight_data_is_fail_closed`.

**Verified by mutation.** I deleted both new blocks in full:

```rust
// removed entirely from RunSpec::validate
if self.cli.as_ref().is_some_and(|cli| cli.trim().is_empty()) { return Err(SpecError::EmptyCli); }
let mut trigger_ids = BTreeSet::new();
for trigger in &self.triggers {
    if trigger.id.trim().is_empty() || trigger.executor.trim().is_empty() { … }
    if !trigger_ids.insert(trigger.id.clone()) { … }
}
```

`cargo test` → **72 passed, 0 failed.** The kernel cannot tell the difference between
having these rules and not having them.

AGENTS.md rule 5 is not aspirational: *"Every kernel behavior has a test."* This is new
kernel behavior with no test.

**Failure scenario:** six months out, someone refactoring `validate()` for the gate-2
trigger dispatcher moves the `trigger_ids` set into the dispatcher and drops it here,
reasoning that dispatch is where uniqueness matters. Full green build. A spec with two
triggers named `hourly` now reaches the kernel, and gate 2 gets to discover at dispatch
time that trigger identity is not unique — the precise minute-27 class the covenant this
PR implements exists to eliminate.

**Remedy:** three asserts in `spec/tests.rs`, in the shape the existing `EmptyStepCli`
assert already uses:

```rust
assert_eq!(spec_with_flow_cli("").validate(), Err(SpecError::EmptyCli));
assert_eq!(spec_with_trigger("", "w").validate(), Err(SpecError::InvalidTrigger("".to_owned())));
assert_eq!(spec_with_triggers(&[("hourly","a"),("hourly","b")]).validate(),
           Err(SpecError::DuplicateTrigger("hourly".to_owned())));
```

Related, and cheap to fix in the same edit: the `malformed` half of
`preflight_data_is_fail_closed` (`spec/tests.rs:124-129`) asserts only `is_err()`. It
does pin *something* — removing `deny_unknown_fields` from `TriggerSpec` turns it red —
but it does not pin *which* error, so a regression that makes `parse` fail for an
unrelated reason keeps it green while the unknown-field guarantee is gone. Match on the
variant.

### M2 — The SDK's duplicate-trigger-id rule is pinned by nothing either

`sdk/src/validate.ts:180` emits `duplicate trigger id "<id>"`. The test that looks like
its coverage — `validate.test.ts`, *"rejects malformed and unknown trigger/CLI fields
fail-closed"* — asserts four substrings (`spec.cli`, `unknown key "worker"`, `executor`,
`steps[0].cli`) and none of them is the duplicate.

**Verified by mutation.** Replacing `else if (ids.has(candidate.id))` with
`else if (false)` → **120/120 pass.**

Taken with M1 this is the same rule unpinned on both sides of the boundary. The parity
story this PR tells everywhere else — `spec-parity.test.ts` proving the SDK and kernel
agree bit-for-bit — has a hole in exactly the field the PR introduced, and the hole is
invisible from a green run. `grep -rn "duplicate trigger" sdk kernel` returns three
hits: two implementations and zero tests.

**Remedy:** one case in `validate.test.ts` asserting `duplicate trigger id "hourly"`.

---

## Non-blocking findings, ordered by how much a stranger will pay for them

### M3 — `probeTrigger`'s `probe_failed` path is both untested and unreachable

`preflight.ts:147-163` wraps `probes.executor(trigger)` in a `try`/`catch` that emits
`probe_failed`. The only production implementation is
`executor: (trigger) => config.executors.includes(trigger.executor)` (`cli.ts:171`) — an
array lookup that cannot throw. Deleting the handler outright leaves 120/120 green
(mutation 3).

It reads as symmetry with `probeResolvedCli`, which is a fair instinct, but AGENTS.md
rule 6 is *"no dead code, no speculative abstraction — build what the current gate
needs."* Pick one: inject a throwing `executor` in `preflight.test.ts` so the branch is
exercised and the symmetry is real, or delete it until gate 2 gives `executor` an
implementation that can actually fail. Leaving it as-is means a future reader cannot
tell whether it is load-bearing.

### M4 — An environment fault during resolution is reported as the author's mistake

`resolveExecutable` (`cli.ts:180-193`) returns `undefined` for three unrelated causes:
the file is absent, the file is present but not executable, or `which` fails/times out.
All three collapse into `cli_missing` and the message *"…but it is missing."*

**Observed:**

```
$ node dist/cli.js check /tmp/revprobe/f.flow.yaml     # cli: ./present-but-not-executable, mode 644
REFUSED [cli_missing] Step "answer" declares CLI "./present-but-not-executable", but it is missing.
```

The file is sitting right there. The author is told to go find it.

This also makes the `preflight.ts` module doc assert more than the code does:

> *A probe may throw when its fact cannot be collected. Preflight catches that boundary
> and emits `probe_failed`.*

True for the `auth status` execution; false for resolution, where an environment fault
(`which` unavailable or timing out at the 5 s bound) becomes a refusal that blames the
spec. Covenant 1 asks for messages that *"name the author's mistake in the author's
vocabulary"* — this one names the wrong mistake.

**Remedy:** have `resolveExecutable` distinguish "not found" from "found, not
executable" and from "resolver failed", then map the third to `probe_failed` and give
the second its own message (the existing `cli_missing` kind is fine; the wording is what
misleads). No new taxonomy entry required.

### M5 — `PreflightProbes.cli` is called once per step, with no stated contract

**Observed:** a 5-step flow sharing one flow-level `cli` spawns **5** identical
`auth status` probes. Combined with the 10 s `spawnSync` timeout in `probeCli`, an
M-step flow against a hung CLI makes `flows check` cost M × 10 s — on the command whose
entire value proposition is "you learn at minute 0."

The public `PreflightProbes` interface says nothing about whether `cli` may be called
repeatedly for the same argument, whether implementations must be idempotent, or whether
they must be cheap. Anyone writing a probe implementation against this interface is
guessing. Either memoize by `(cli, source)` inside `preflight()` — the natural fix,
since resolution is already computed per step — or state the repetition contract in the
interface doc.

Also uncommented while here: the `10_000` and `5_000` timeouts are bare literals on the
two spawn sites.

### M6 — `docs/SURFACE.md` asserts printing that `flows check` does not do

The revised §2 sentence reads:

> The elaborated definition — cli, identity (derived from the flow: `<flow>/agent`),
> workspace scopes, budget, tools — **is printed and validated by `flows check`**…

`emitReport` (`cli.ts:207-222`) prints exactly one line per resolution:
`RESOLVED step "<id>" cli "<cli>" from <source>`. No identity, no workspace scopes, no
budget, no tools.

In isolation this would be ordinary aspirational prose in an aspirational document. What
makes it a finding is that **this PR carefully scoped the immediately adjacent clause to
gate-1 reality** — *"The platform-default rung is declared but not yet implemented…as of
gate 1"* — and added two new paragraphs of genuinely present-tense contract below it. A
reader now reasonably assumes the unscoped clauses are also present-tense. Half the
sentence describes today; half describes gate 4. Give the aspirational half the same
one-clause scoping the platform-default rung got.

*(The two new paragraphs I checked against the code — the preflightable-CLI contract and
project-config discovery — are accurate: path-relative-to-declaring-file resolution
matches `systemProbes`, and nearest-config-wins matches `findConfig`. Good docs.)*

### M7 — The garbled fixture header is still there, in all three canonical fixtures

```
# The CLI these rungs hire is resolved at preflight from the project
# default (testdata/flows.json), so the canonical spec and its hash pin
# name no environment-specific binary and no test fixture.
```

"…and its hash pin name no environment-specific binary…" is not a sentence, and it is
copied verbatim into `hello-ladder`, `hello-llm`, and `hello-agent` — the headers on the
repo's load-bearing SDK↔kernel parity fixtures. It was flagged in the 18:29 round of
this same lens and is unchanged five rounds later.

Worth noting the claim is also *narrower than it reads*: the spec and hash pin no
fixture binary (true — `cli` is absent from the YAML), but `flows check` on these flows
absolutely depends on the `testdata/preflight/authenticated-cli` fixture, as my build
probe shows it resolving. One clean sentence, three files.

### M8 — The packaged `flows` binary is not exercised by CI

`package.json` gained `"bin": { "flows": "./dist/cli.js" }`, but `npm test` runs
`tsc --noEmit && vitest run` — it never runs `tsc`, and every test drives `runCli()`
in-process. Nothing in CI would notice if emit broke for the packaged entry point.

I built and ran it: the shebang survives, `node dist/cli.js check` exits 0 with correct
output. So this is a gap in the net, not a defect today. One `npm run build && node
dist/cli.js check testdata/hello-ladder.flow.yaml` in the test script would close it.

---

## Nits

- `CliProbeResult` is still not exported from `index.ts`, though it is the return type of
  the exported `PreflightProbes.cli`. A consumer can satisfy the interface structurally
  but cannot name what it returns. Raised in the 18:29 round; the sibling half of that
  note (`CHECK_INPUT_FAILURE_KINDS`) was fixed, this half was not.
- Step-type dispatch is duplicated: `preflight()` does
  `if (step.type === 'deterministic') continue;` and `warnOnUnprovableEffects()` opens
  with `if (step.type !== 'deterministic') return;`. Adding a fourth step type means
  remembering both sites.
- `runCli` returns 0 or 2 and never 1. That contract lives only in test assertions —
  neither the code nor `SURFACE.md` states it. One comment on `runCli`.
- `kernelDialectMarker(parsed)` is computed twice in `readFlow` (routing, then the error
  message).
- 30 of the 60 changed files are `ops/reviews/` transcripts, ~6,000 of the 9,193 diff
  lines. This is deliberate under RFC §2 rule 3 (the program journals its own
  trajectory), not sloppiness — but a stranger opening this PR should be pointed at the
  ~1,000 lines that are the change. A line in the PR description would do it.

---

## Verdict

The core of this PR is good work and I want that on the record: the pure-probe boundary,
the closed taxonomy, the honest note about which guarantee comes from the test and which
from the compiler, and the relocation control on the ladder-fault suite are all things a
stranger can read in six months and trust. The self-judging-gate problem from the
previous round is genuinely closed — `workflows/` is byte-identical to `main`.

It fails this lens on one specific axis: **new validation rules that no test can
distinguish from their own absence.** M1 and M2 are not style opinions — I deleted the
code and both suites stayed green, and AGENTS.md rule 5 names this exact failure as a
gate rather than a nice-to-have. Duplicate trigger ids are, as far as CI is concerned,
unvalidated in both the SDK and the kernel, in the same PR that introduces triggers.

The fix is roughly four asserts. Land those and this passes.

REVIEW_FAILED
