# PR 8 — WP-4 `flows check` preflight (covenant 2)

**Lens:** maintainability — could a stranger read this in six months and change it safely?
**Reviewed at:** `f678af3` (branch `flow/drive-57e923c-08271542`). Last code-bearing commit: `9aecc41`; everything after it is ops artifacts.
**Scope read:** `AGENTS.md`, `docs/RFC-0001-everything-is-a-relayflow.md`, `docs/SURFACE.md`, the full diff (`/tmp/pr-8.diff`), and the working tree.
**Verdict:** **REVIEW_FAILED** — three findings, each verified by running or mutating this tree. M1 lets a maintainer turn a correct refusal into `CHECK PASSED` with the whole suite green.

---

## Verification actually performed

Every claim marked *(verified)* was produced by executing or mutating this tree.
The working tree was restored and rebuilt after each mutation; `git status --porcelain`
shows only the concurrent reviewers' own files.

| # | Action | Result |
|---|--------|--------|
| 1 | `npm test` in `sdk/` (`tsc --noEmit && vitest run`) | **127 passed / 8 files / 0 failed** |
| 2 | `cargo test` in `kernel/` | **could not run** — see "What I could not verify" |
| 3 | Present-but-non-executable CLI (`chmod 644`), checked through the built binary | `REFUSED [cli_missing] … "./noexec-cli", but it is missing.` — file demonstrably present. Finding **M2** |
| 4 | `auth status` fixture that `sleep 60`, checked with `--json` | 10.06s wall, `REFUSED [probe_failed] Could not verify CLI "./hang-cli" for step "answer".`, no cause in the JSON either. Finding **M3** |
| 5 | Mutation: `cacheKey = resolution.cli` (drop `source`) | **127/127 still green.** Finding **M1** |
| 6 | Same mutation, run end-to-end against a two-source flow (step-level `./shared-cli` present, project-level `./shared-cli` absent) | unmutated: `REFUSED [cli_missing]`, exit 2. Mutated: **`CHECK PASSED`, exit 0** — the covenant-2 false green, reproduced |
| 7 | Mutation: cap `findConfig`'s parent walk at one hop | **127/127 still green.** Finding **M5** (carried, still open) |
| 8 | Mutation: replace `firstCommandWord`'s regex with `/^([^\s]+)/`, deleting both quote branches | **127/127 still green.** Finding **M6** |
| 9 | Grep audit: any comment or test binding `kernelDialectMarker`'s key list to `kernel/…/spec.rs`'s `STEP_*_FIELDS` or `compile.ts`'s `unionKeys` | **none.** Finding **M4** |
| 10 | Audit of every new claim in `docs/SURFACE.md` against the code | all eleven hold (details below) |
| 11 | `git diff --numstat main...HEAD`, excluding `package-lock.json` | **10,774 ops-markdown lines vs 1,889 lines of everything else.** Finding **M8** |

---

## What reads well, and should survive any rewrite

Not generosity — these are the parts a stranger will lean on, and I checked each.

- **The pure/impure seam is real and enforced by shape.** `sdk/src/preflight.ts` takes
  `PreflightProbes` and performs no I/O; `sdk/src/cli.ts:178` `systemProbes` is the only
  place `spawnSync`/`accessSync` meet preflight logic. That is why `preflight.test.ts` can
  inject a throwing probe and get a deterministic `probe_failed` with no fixture
  filesystem. Someone changing refusal *logic* never has to think about processes.
- **The taxonomy is closed, centralized, and typed.** `sdk/src/failure-kinds.ts` is 43
  lines and is the single answer to "what can `flows check` say?", split into preflight
  vs. input kinds. `preflight.test.ts:127-131` records that the *converse* of the
  reachability tests — no path emits an undeclared kind — is held by `tsc --noEmit`, not
  by the test. Declining to overclaim what a test proves is exactly right, and rare.
- **`preflight.ts:192-199` explains *why* deterministic steps warn instead of refusing**
  (a string command goes through `/bin/sh -c`, so an unresolved first word may be a
  builtin, function, or assignment). I checked `kernel/relayflowd/src/exec_det.rs`; the
  comment is load-bearing and true. Without it the warn/refuse split reads as timidity.
- **`cli.test.ts:145-153` is a control case that reasons about its own validity** —
  relocated-but-unmutated ladder flows must still pass, so the induced-fault refusals
  cannot be an artifact of the temp directory. `temporaryProject()` likewise writes a
  boundary `flows.json` into every temp dir so a stray `/tmp/flows.json` cannot make the
  suite green for the wrong reason.
- **`bin.test.ts` builds the artifact itself and exercises the *shipped* binary** through
  a symlink and through a symlinked directory component. The prior round's "installed
  `bin` is inert" defect is genuinely closed and genuinely pinned, not asserted closed.
- **The `--json` report is pinned with a full `toEqual` for both a pass and a refusal**
  (`cli.test.ts:185-216`), so the machine-readable contract cannot drift silently.
- **`docs/SURFACE.md` now discloses what gate 1 does *not* guarantee** — `run.start` does
  not invoke surface preflight, and the auth probe inherits the checker's complete caller
  environment — and both are filed in `ops/BACKLOG.md` rather than left implicit. Under
  covenant 2 that honesty is worth more than the code it qualifies.

None of this is undone by the verdict. The failure is at the seams where this discipline stops.

---

## Findings

### M1 — the probe cache key's `source` component is load-bearing for correctness and nothing pins it *(verified by mutation and by end-to-end reproduction)*

`sdk/src/preflight.ts:124`:

```ts
const cacheKey = JSON.stringify([resolution.cli, resolution.source]);
```

`source` is in that key for a reason that is not visible anywhere near it: a relative
`cli` resolves against a *different base directory* per source — the flow file for
`step`/`flow`, the `flows.json` directory for `project` (`cli.ts:180`). Two steps can
therefore declare the byte-identical string `./shared-cli` and mean two different files.

The rule is stated in `PreflightProbes.cli`'s docstring (`preflight.ts:26`, a different
declaration) and in `docs/SURFACE.md`'s "once per resolved `(cli, source)`". It is stated
nowhere at the cache, and it is pinned by no test.

**Failure scenario (reproduced end-to-end).** Given `/root/flows.json` declaring
`cli: ./shared-cli`, a healthy `/root/nested/shared-cli`, no `/root/shared-cli`, and
`/root/nested/f.flow.yaml` with step `one` declaring `cli: ./shared-cli` and step `two`
declaring none:

- shipped code → `REFUSED [cli_missing] Step "two" …`, exit 2. Correct.
- after `cacheKey = resolution.cli` → `CHECK PASSED`, exit 0, **and 127/127 tests green.**

A maintainer simplifying a `JSON.stringify` of a two-element array into a plain string —
an unremarkable cleanup — silently converts a refusal into a pass. That is precisely the
covenant-2 failure this PR exists to prevent, reintroduced through the PR's own code, with
nothing in the repo objecting.

**Fix:** a test with two sources resolving the same `cli` string to different files, plus a
one-line comment at the cache key naming the base-directory coupling. Both are cheap; the
absence of either is what makes this blocking rather than a nit.

### M2 — `cli_missing` tells the author a file is missing while the file is present *(verified)*

`cli.ts:198-211` `resolveExecutable` collapses "does not exist" and "exists but is not
executable" into a single `undefined`: `accessSync(path, X_OK)` throws for ENOENT and for
EACCES alike, and the `catch` returns `undefined` either way. `preflight.ts:144-151` then
emits:

```
REFUSED [cli_missing] Step "answer" declares CLI "./noexec-cli", but it is missing.
```

Verified against a file that is present, 17 bytes, mode `644`.

Covenant 1 requires error messages to "name the author's mistake in the author's
vocabulary." The author's mistake here is a missing `chmod +x`; they are told the file does
not exist. An author who trusts the message will go looking for a build or install problem
that does not exist. The deterministic-command path gets this right — `command_unresolved`
says "does not resolve as an executable", which is true of both cases — so the repo already
contains the correct wording one function away.

No test covers a present-but-non-executable CLI, so the message can be wrong indefinitely.

**Fix:** distinguish the two `accessSync` failures (or reword to "did not resolve as an
executable", matching the deterministic path), and add the fixture.

### M3 — `probe_failed` carries no cause, so the one refusal that means "we could not prove this" gives the operator nothing *(verified)*

`cli.ts:194` deliberately discards the underlying cause:

```ts
if (result.error !== undefined || result.signal !== null) throw new Error('probe failed');
```

`preflight.ts:134-142` catches it and emits a fixed string. Three materially different
causes produce byte-identical output:

| Cause | Operator action | Message |
|---|---|---|
| spawn failed (no `which` on PATH, EACCES) | fix the checker's environment | `Could not verify CLI "X" for step "Y".` |
| probe killed by SIGSEGV | file a bug against the CLI | *identical* |
| probe hung, killed at the 10s timeout | investigate the CLI's network/auth backend | *identical* |

Verified: a `sleep 60` auth fixture produced that exact string after 10.06s, and the
`--json` report carried no more than the human line — `PreflightRefusal` has fields for
`cli`, `stepId`, `triggerId`, `executor`, but none for a cause or detail, so the machine
contract cannot carry one either.

Two aggravating details. The 10-second hang produces **no output at all** while it runs, so
a flow with several distinct CLIs stalls in N×10s increments with nothing on either stream.
And `docs/SURFACE.md` enumerates the signal and unresolvable cases for `probe_failed` but
never mentions the timeout or its duration, so the one cause an operator is most likely to
hit is the one the contract does not name.

The `raw secret` assertions in `preflight.test.ts:124` and `:145` correctly stop probe
*exception text* from reaching diagnostics. They do not require that a cause be
*classified* — suppressing the text and dropping the information are being treated as the
same requirement, and they are not.

**Fix:** add a `detail?: string` to `PreflightRefusal` carrying a classified, non-verbatim
cause (`spawn_failed` / `signal:SIGSEGV` / `timeout:10000ms`); name the timeout and its
value in SURFACE.md.

### M4 — the kernel-dialect field set must be maintained in three files and no file names the other two

A snake_case kernel field must be registered in all of:

1. `kernel/relayflowd-core/src/spec.rs:143-152` — `STEP_LLM_FIELDS` / `STEP_AGENT_FIELDS`
2. `sdk/src/compile.ts` — `kernelStepToAuthoring`'s `unionKeys` and the per-type key lists
3. `sdk/src/cli.ts:251-254` — `kernelDialectMarker`'s `kernelStepKeys` and friends

This PR edited (1) and (2) for `cli` and correctly left (3) alone, because `cli` is spelled
identically in both dialects and so is not a *marker*. That is a genuinely subtle judgment
call, and the next person has to re-derive it from scratch: no comment in any of the three
files mentions the other two, and no test cross-checks the lists (verified by grep).

Consequence of a miss: a compiled kernel spec carrying only the new field is not recognized
as kernel dialect, is validated as authoring input, and is refused with a message naming
the wrong dialect — a confusing failure at a user, not a red build. The current marker list
*is* complete (I checked every field that differs between the dialects), and
`cli.test.ts:224-256` pins each existing marker with its own row. The gap is purely
prospective, which is why it is not blocking — but it is the kind of gap that costs an
afternoon to diagnose and thirty seconds to prevent with a comment.

### M5 — the documented root-ward `flows.json` walk is pinned only one hop deep *(verified by mutation; carried, still open)*

`docs/SURFACE.md` now states that `flows check` "walks parent directories through the
filesystem root and selects the first readable `flows.json`." Capping `findConfig`
(`cli.ts:162-176`) at one parent leaves **127/127 green**: every test places the config
either in the flow's own directory or exactly one level up.

The prior round raised this. `9aecc41` responded by making the documented claim *more*
specific — adding the root-ward walk, the shadowing rule, and the config schema to
SURFACE.md — without adding the test. Documentation and test coverage moved in opposite
directions. A two-hop fixture is a three-line addition to an existing test.

### M6 — `firstCommandWord`'s shell-quoting branches are speculative and entirely unexercised *(verified by mutation)*

`preflight.ts:243-246`:

```ts
const match = command.trim().match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
```

Replacing this with `/^([^\s]+)/` — deleting both quote alternatives — leaves **127/127
green**. No fixture or test anywhere in the repo uses a command string whose first
character is a quote (I enumerated every `command:` value in `sdk/tests` and `testdata`).

This is a hand-rolled partial shell tokenizer sitting in the function that decides which of
three warning kinds an author sees, and two thirds of it is unreachable by the suite.
AGENTS.md rule 6: "No dead code, no speculative abstraction. Build what the current gate
needs." Either pin the quoted forms with a fixture or drop the branches until a gate needs
them.

### M7 — `testdata/flows.json` gives every flow under `testdata/` an always-healthy CLI, and nothing says so

The new `testdata/flows.json` sets `cli: ./preflight/authenticated-cli` at the testdata
root. That is deliberate and correct for the canonical ladder — it keeps the hashed spec
free of any environment-specific binary. But it also means *any* flow placed anywhere under
`testdata/` silently inherits a fixture whose `auth status` always exits 0.

The suite is meticulous about this hazard in the other direction: `temporaryProject()`
writes a boundary `flows.json` into every temp directory specifically "so `/tmp/flows.json`
cannot affect it." The repo's own fixture root has the opposite property and no such note.
A future test author adding a fixture that *should* refuse `cli_unresolved` will get a
green test that proves nothing, and the comment they would have read is in a different
directory.

### M8 — the ops record has outgrown the ability to answer "what is still open?"

Excluding `package-lock.json`, this PR is **10,774 lines of ops markdown against 1,889
lines of code, tests, fixtures, and docs combined** — a 5.7:1 ratio. `ops/reviews/` is now
42 timestamp-named files totalling 9,999 lines, with no index and no rollup; ten rounds of
the same three lenses on this one PR each restate the previous round's findings in full.
`ops/DRIVE-LOG.md` is 1,649 lines and grew by 1,210 in this PR alone.

This is in scope for this lens. In six months, "what is still open on PR #8?" is answerable
only by reading roughly five thousand lines of superseded review prose and diffing it
against itself — and the answer will be wrong, because the closed findings are not marked
closed anywhere except inside later rounds' prose. RFC §2 rule 5 makes pruning the norm
("added when a review surfaces a new failure class and pruned when they stop firing");
nothing in this PR prunes anything.

A single `ops/reviews/PR8-OPEN.md` carrying the live findings, with superseded rounds
marked as such, would cost one file and make the record usable. That is the actual
deliverable of a review swarm — the current shape optimizes for evidence of having
reviewed over the ability to act on it.

---

## Nits

- All three canonical ladder fixtures (`testdata/hello-{ladder,llm,agent}.flow.yaml`)
  repeat a garbled sentence: *"so the canonical spec and its hash pin name no
  environment-specific binary and no test fixture."* Reads like a botched edit of "…and its
  hash name no…". These are the most-read files in the repo.
- `spec.ts:` `/** Spec schema semver (RFC §7). Compilers always emit latest. */` on
  `version` now understates the contract. `validate.ts` accepts exactly
  `SPEC_SCHEMA_VERSION` and rejects every other semver. A reader of the type will guess
  wrong about `0.2.0`.
- `FlowSpec.name` silently became optional with no note in `docs/SURFACE.md` and no comment
  recording the *driver* — nameless kernel-dialect specs must round-trip. The test says
  "because the kernel treats it as optional", which is the justification, not the reason
  this PR needed it.
- `PreflightProbes.executor(trigger: TriggerSpec)` receives the whole trigger but every
  implementation and call site reads only `trigger.executor`. Speculative width
  (AGENTS.md rule 6).
- `ProjectConfig.directory` means "the config's directory" when a config exists and "the
  flow's directory" when none does, and is only ever read in the first case. A reader could
  reasonably take it for "project root" and use it wrongly.
- `warnOnUnprovableEffects` re-tests `step.type === 'deterministic'` that its caller tests
  on the very next line (`preflight.ts:70-71`), and its name does not say "deterministic
  only" — only its docstring does.
- The timeouts `10_000` (auth probe, `cli.ts:192`) and `5_000` (`which`, `cli.ts:208`) are
  unnamed magic numbers, documented nowhere, with no stated trade-off for whoever tunes them.
- `readProjectConfig` rejects every key outside `cli`/`executors`, so the conventional
  `"$schema"` key in a `flows.json` is a hard `config_invalid`. Fail-closed is right; this
  particular key is common enough to be worth an exemption or a mention.

---

## What I could not verify

**Kernel tests did not run.** `~/.cargo/registry` is a symlink to
`/Volumes/Paris Drive/…/cargo-registry`; that volume is not mounted (`/Volumes` contains
only `Macintosh HD`), so `cargo test` fails at index fetch with
`failed to create directory … File exists (os error 17)`. This is an environment fault, not
a defect in the PR. Consequently:

- `ops/SCOREBOARD.md`'s "kernel 72 tests" is **unverified by me**.
- The Rust half of this PR (`spec.rs` trigger/CLI validation, `machine/tests.rs`
  completion-reason coverage) was read but not executed. Nothing in my reading suggests a
  problem: the new `SpecError` variants are exhaustively matched in the new
  `preflight_data_is_fail_closed` test, and the completion-reason test iterates the closed
  enum rather than sampling it.

The SDK figure in SCOREBOARD — 127 tests — **matches exactly** what I measured.

---

## Verdict

The architecture here is good and the honesty is better than the code. The pure/impure seam,
the closed taxonomy, the control case that reasons about its own validity, and the
SURFACE.md paragraphs that disclose what gate 1 does *not* guarantee are all things a
stranger in six months will be glad of.

The verdict turns on what happens when that stranger edits it:

- **M1** — the single expression that keeps two different files with the same name apart
  can be "simplified" into a false `CHECK PASSED` with 127/127 green. Under covenant 2, a
  preflight that can silently stop refusing is worse than no preflight.
- **M2** — the tool tells the author something false about their own filesystem, on a path
  no test covers, while the correct wording exists one function away.
- **M3** — the refusal kind that exists to say "we could not prove this" says nothing else,
  including after a silent ten-second stall the contract never mentions.

M1 is a two-line fix (a comment and a test). M2 and M3 are small. None requires redesign;
all three are places where the discipline the rest of this PR demonstrates simply stops.

**REVIEW_FAILED**
