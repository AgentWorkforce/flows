# PR 8 — WP-4 `flows check` preflight (covenant 2)

**Lens:** maintainability — could a stranger read this in six months and change it safely?
**Reviewed at:** `c6d7266` (branch `flow/drive-57e923c-08271542`). Last code-bearing commit: `e1c1f21`; `c46bd57` and `c6d7266` are ops artifacts.
**Scope read:** `AGENTS.md`, `docs/RFC-0001-everything-is-a-relayflow.md`, `docs/SURFACE.md`, the full diff (`/tmp/pr-8.diff`), and the working tree.
**Verdict:** **REVIEW_PASSED** — the three blocking findings from the previous round are closed, and I verified each by execution rather than by reading the fix commit. Six findings remain, recorded below; none is blocking, and I say why for each.

---

## Verification actually performed

Every claim marked *(verified)* was produced by executing or mutating this tree. The tree
was restored after each mutation; `git status --porcelain` at the end shows only the two
concurrent reviewers' own untracked files, and `git diff --stat` is empty.

| # | Action | Result |
|---|--------|--------|
| 1 | `npm test` in `sdk/` (`tsc --noEmit && vitest run`) | **130 passed / 8 files / 0 failed** |
| 2 | `(cd kernel && ../ops/cargo.sh test --workspace)` | **72 passed / 0 failed** — the SCOREBOARD figure, verified |
| 3 | Mutation: `cacheKey = resolution.cli` (drop `source`) — last round's M1 | **1 failed / 129 passed.** M1 is now pinned |
| 4 | Mutation: `systemProbes` ignores `source` when choosing the base directory | **1 failed** (`resolves a project CLI path relative to the flows.json that declares it`). The other half of M1 is pinned end-to-end |
| 5 | Live: present, mode-`644` CLI through the built binary | `REFUSED [cli_missing] … "./noexec", but it does not resolve as an executable.` M2 closed |
| 6 | Live: `sleep 60` auth fixture, `--json`, through the built binary | 10s wall, `…: the probe timed out after 10000ms.`, and `"detail":"timeout:10000ms"` in the JSON report. M3 closed |
| 7 | Mutation: `code === 'ETIMEDOUT'` → `'ENEVER'` | **130/130 still green.** Finding **N1** |
| 8 | Mutation: `timeout: 10_000` → `30_000`, classifier argument left at `10_000` | **tsc clean, 130/130 green**, message would state a false duration. Finding **N2** |
| 9 | Mutation: added `'permission_denied'` to `CliProbeFailureDetail` | **tsc raises nothing**; the message renders `the probe timed out after on_denied.` Finding **N3** |
| 10 | Mutation: added `EnvironmentLost` to `CompletionReason` (kernel) | **compiles clean, 72/72 green**; the "every failed run" test silently stops covering it. Finding **N4** |
| 11 | Mutation: cap `findConfig`'s parent walk at one hop | **130/130 green.** Finding **M5** (carried, still open) |
| 12 | Mutation: `firstCommandWord` regex → `/^([^\s]+)/`, deleting both quote branches | **130/130 green.** Finding **M6** (carried, still open) |
| 13 | Node behaviour check: `spawnSync` with `timeout` | sets `error.code === 'ETIMEDOUT'` **and** `signal === 'SIGTERM'`; `classifySpawnFailure` checks `error` first, so the classification is correct |
| 14 | Count: `ops/reviews/` files and lines; `git diff --numstat main...HEAD` | 45 files / 10,469 lines, no index; 10,967 of 12,959 added lines are `ops/`. Finding **M8** |

---

## What last round blocked on, and what actually closed

I did not take the fix commit's word for any of these.

**M1 — the probe cache key's `source` component was load-bearing and unpinned. Closed, twice over.**
`preflight.ts:141-143` now carries a comment naming the base-directory coupling at the cache
key itself, and `preflight.test.ts:79` (`keeps identical relative CLI strings separate across
resolution sources`) pins it: dropping `source` from the key takes the suite to 1 failed / 129
passed. Better than asked for, the *other* half — that `systemProbes` actually picks a
different base directory per source — turns out to be pinned end-to-end by
`cli.test.ts:295`, which I confirmed by mutating `cli.ts:181` and watching that test fail.
The covenant-2 false green reproduced last round can no longer be reintroduced silently.

**M2 — `cli_missing` claimed a present file was absent. Closed.**
The message is now "does not resolve as an executable", matching the wording the
deterministic path already used, and `bin.test.ts:100` drives a real mode-`644` file through
the built binary with an explicit `not.toContain('but it is missing')`. I reproduced the
live output. `docs/SURFACE.md` was updated in the same breath ("a path that does not resolve
as an executable is `cli_missing`"), so the kind name and the message no longer disagree
without a note — the kind is still slightly narrower than what it covers, but the contract
now says so.

**M3 — `probe_failed` carried no cause. Closed, including the machine contract.**
`CliProbeError` carries a classified `CliProbeFailureDetail`, `PreflightRefusal` gained
`detail?`, and the three causes now produce three distinct messages. I ran the 10-second hang
end to end: the human line reads `the probe timed out after 10000ms` and the `--json` report
carries `"detail":"timeout:10000ms"`. `preflight.test.ts:99` keeps the old
`raw secret` suppression assertion alongside the new classification assertion, so
"suppress the text" and "carry a cause" are now held as two separate requirements — which is
exactly the distinction last round said was being conflated. SURFACE.md now names the
timeout and its value.

That is three for three, verified by execution. The work is real.

## What else reads well

- **The pure/impure seam survived the fix.** `CliProbeError` is declared next to
  `PreflightProbes` — the probe *protocol* lives with the probe interface — and thrown from
  `cli.ts`, the only module that meets `spawnSync`. The new plumbing widened the contract
  without putting I/O in `preflight.ts`.
- **`classifySpawnFailure` is shared by both spawn sites** (`auth status` and `which`), so the
  two probes cannot drift into different failure vocabularies. That is the right shape.
- **`RunSpec.triggers`' docstring names its own boundary** — "Inert gate-1 declarations.
  Matching and dispatch belong to gate 2." A stranger reading `spec.rs` learns why the field
  does nothing, which is the question they would otherwise file a bug about.
- **`preflight_data_is_fail_closed` exhaustively matches the new `SpecError` variants** rather
  than sampling them, and the `deny_unknown_fields` case pins that a guessed `worker` key on a
  trigger is refused rather than ignored.
- **The prior round's garbled fixture comment was fixed** in all three ladder flows.

---

## Findings

### N1 — the timeout classification `SURFACE.md` now advertises is pinned by nothing *(verified by mutation)*

`cli.ts:222` is the single line that turns a hung probe into `timeout:` rather than
`spawn_failed`:

```ts
const detail = (error as NodeJS.ErrnoException).code === 'ETIMEDOUT' ? … : 'spawn_failed';
```

Replacing `'ETIMEDOUT'` with a string that never matches leaves **130/130 green**. Every hung
CLI would then tell the operator `the probe process could not be started` — about a process
that started fine and ran for ten seconds. That is M2's defect (a message that sends the
author to the wrong place) reappearing on the path M3's fix created.

The unit test at `preflight.test.ts:99` throws `new CliProbeError('timeout:10000ms')` directly,
so it pins the *rendering* of a detail the production classifier might never produce. The two
`bin.test.ts` cases cover `signal:` and `spawn_failed` against the real binary; the timeout is
the one cause with no end-to-end coverage — understandably, since it costs ten seconds of wall
clock.

**Not blocking:** I executed the real path (verification #6) and it is correct today. This is a
coverage gap over verified-correct behaviour, the same class as M5 and M6.
**Fix:** a fixture CLI with a `sleep`, checked with an injected shorter timeout — or, cheaper,
a direct unit test of `classifySpawnFailure` against a synthetic `{ code: 'ETIMEDOUT' }`, which
costs no wall clock at all and pins the one line that matters.

### N2 — the probe duration is two independent literals, and the diagnostic will state the wrong one *(verified)*

`cli.ts:190-195`:

```ts
const result = spawnSync(executable, ['auth', 'status'], { …, timeout: 10_000 });
const failure = classifySpawnFailure(result.error, result.signal, 10_000);
```

The duration appears twice with nothing tying the copies together. Changing the spawn option to
`30_000` and leaving the classifier argument at `10_000` **type-checks and leaves 130/130
green**, after which a probe that hung for thirty seconds reports `timed out after 10000ms` and
SURFACE.md's "10-second auth-probe timeout" is also stale. The same duplication exists for
`5_000` in `resolveExecutable`.

The `timeoutMs: 5_000 | 10_000` parameter type is clearly *trying* to enforce this — it stops
you passing an undeclared duration — but it constrains the argument, not its agreement with the
spawn option, which is the half that matters. The trade-off is also undocumented: nothing says
why an auth probe gets ten seconds and `which` gets five, so whoever tunes them is guessing.

**Not blocking:** prospective — it takes a future edit to bite, the same reason M4 was rated
non-blocking last round.
**Fix:** two named constants (`AUTH_PROBE_TIMEOUT_MS`, `WHICH_TIMEOUT_MS`) used at both sites,
with a one-line note on the choice.

### N3 — `probeFailedMessage`'s fall-through asserts "timed out" about any cause it does not recognise *(verified)*

`preflight.ts:187-198` handles `spawn_failed`, then `signal:`, then *assumes* everything
remaining is a timeout and slices `'timeout:'.length` off it. Adding a variant to
`CliProbeFailureDetail` — the obvious next edit, since the union is where causes are declared —
draws no objection from `tsc`, and renders:

```
Could not verify CLI "x" for step "y": the probe timed out after on_denied.
```

A message that is both false and visibly garbled, produced by a build with nothing red.

This matters more than the usual missing-`default` case because the whole point of M3's fix was
that `probe_failed` must tell the operator what actually happened. A silent fall-through is the
one failure mode that turns "no information" into "wrong information."

**Not blocking:** prospective, and the current three-variant set is handled correctly.
**Fix:** end with an exhaustiveness guard — assign the remaining `detail` to a `never`-typed
local, or match `timeout:` explicitly and let the true fall-through return the bare prefix.
Either makes the next variant a compile error instead of a lie.

### N4 — the kernel's "every failed run" test iterates a hand-maintained list, not the enum *(verified by mutation)*

`machine/tests.rs:65` opens `every_failed_run_terminates_with_declared_completion_reasons` with
a literal array of eight `CompletionReason` variants. That array happens to be complete today
(the enum has exactly those eight plus `Success` — I checked `entry.rs:159-169`), but nothing
holds it complete. Adding `EnvironmentLost` to the enum **compiles clean and leaves 72/72
green**, with the test's name still claiming "every".

That is not a hypothetical variant: RFC covenant 2 names `environment_lost` and `needs_human`
in the closed failure set the kernel is expected to grow into. The first person to add one will
get a green build and a test whose name says it covered them.

**Not blocking:** the list is complete as shipped, and the test does real work — it drives each
reason through `completion_actions` → `RunState::fold` → `next_actions` rather than asserting on
a constructor.
**Fix:** derive the list from an exhaustive `match` on `CompletionReason` (a small helper
returning `is_failure`, with no `_` arm) so a new variant forces a decision at compile time.
This is cheap in Rust and is the idiom the same file already uses for `SpecError`.

### M4 — the kernel-dialect field set is maintained in three files and no file names the other two *(carried, unchanged)*

Registering a snake_case kernel field still requires touching `kernel/…/spec.rs`'s
`STEP_LLM_FIELDS`/`STEP_AGENT_FIELDS`, `compile.ts`'s `unionKeys` and per-type lists, and
`cli.ts:268-271`'s `kernelDialectMarker` — with no comment in any of the three naming the
others, and no test cross-checking them. This PR got the judgment right (`cli` is spelled
identically in both dialects, so it is not a *marker* and correctly stays out of the third
list), but the next person re-derives that from scratch. The failure mode is a confusing
message at a user, not a red build.

Unchanged since last round; still the cheapest finding in this file to close (three comments).

### M5 — the documented root-ward `flows.json` walk is still pinned one hop deep *(carried, verified still open)*

`docs/SURFACE.md` states that `flows check` "walks parent directories through the filesystem
root." Capping `findConfig` (`cli.ts:163-177`) at one parent leaves **130/130 green**: every
fixture places the config in the flow's own directory or exactly one level up. This has now been
raised twice; the response last round was to make the documented claim more specific without
adding the test. A two-hop fixture is a three-line addition to `temporaryProject()`.

### M6 — `firstCommandWord`'s quote branches remain unexercised *(carried, verified still open)*

`preflight.ts:281`'s hand-rolled partial shell tokenizer still has two of its three
alternatives unreachable by the suite: replacing the regex with `/^([^\s]+)/` leaves
**130/130 green**, and no fixture anywhere starts a `command:` with a quote. AGENTS.md rule 6
("no dead code, no speculative abstraction") points at either a fixture or a deletion. The
function chooses which of three warning kinds an author sees, so it is not inert code.

### M7 — `testdata/flows.json` gives every flow under `testdata/` an always-healthy CLI, and nothing says so *(carried, unchanged)*

The root `testdata/flows.json` sets `cli: ./preflight/authenticated-cli`, which is right for
the canonical ladder — it keeps the hashed spec free of environment-specific binaries, and the
ladder fixtures' header comments now explain exactly that. But the inheritance is
directory-wide: a future fixture dropped anywhere under `testdata/` that *should* refuse
`cli_unresolved` will silently pass instead. The suite is scrupulous about the mirror-image
hazard — `temporaryProject()` writes a boundary `flows.json` into every temp directory "so
`/tmp/flows.json` cannot affect it" — and that note lives in a different file from the fixture
root it would warn about. One comment in `testdata/flows.json` closes it.

### M8 — the review record still cannot answer "what is still open?" *(carried, and larger)*

`ops/reviews/` is now **45 files and 10,469 lines** with no index and no rollup; `ops/` accounts
for **10,967 of the 12,959 lines this PR adds** (excluding `package-lock.json`). Eleven rounds
of the same three lenses each restate their predecessors in full.

The concrete cost, which I paid writing this review: `ops/BACKLOG.md` is well-kept and does
carry four deferred items by name (the Codex P1 deterministic-command gap, the `steps: []`
asymmetry, the WP-7 F6 probe-environment scoping, and others) — but **none of M4 through M8
appears in it**. Five carried findings exist only inside superseded review prose, so
reconstructing the open set means diffing eleven rounds against each other. I did that; it took
longer than reviewing the code.

RFC §2 rule 5 makes pruning the norm — rules are "added when a review surfaces a new failure
class and pruned when they stop firing." One `ops/reviews/PR8-OPEN.md` carrying the live
findings, with superseded rounds marked as such, costs one file. Alternatively, promote M4–M8
into `ops/BACKLOG.md`, which already does this job well for everything else.

**Not blocking:** it concerns the record rather than the shipped code, and BACKLOG proves the
habit exists. But this is the second round it has been raised, and the number grew.

---

## Nits

- `spec.ts:162`'s `/** Spec schema semver (RFC §7). Compilers always emit latest. */` still
  understates the contract: `validate.ts` accepts exactly `SPEC_SCHEMA_VERSION` and rejects
  every other semver. A reader of the type will guess wrong about `0.2.0`. *(carried)*
- `FlowSpec.name` is optional with no note in `docs/SURFACE.md` and no comment recording the
  driver (nameless kernel-dialect specs must round-trip). *(carried)*
- `PreflightProbes.executor(trigger: TriggerSpec)` still receives the whole trigger while every
  implementation and call site reads only `trigger.executor`. *(carried)*
- `probeTrigger`'s `probe_failed` gained no `detail` and keeps a bare `catch`, so the two
  `probe_failed` producers now have asymmetric contracts. The executor probe is a pure array
  lookup and cannot throw today, which makes that branch closer to dead than to unpinned.
- `ProjectConfig.directory` still means "the config's directory" when a config exists and "the
  flow's directory" when none does, and is only read in the first case. *(carried)*
- `warnOnUnprovableEffects` re-tests `step.type === 'deterministic'` that its caller tests on
  the previous line (`preflight.ts:88`), and only its docstring says "deterministic only".
  *(carried)*
- `SURFACE.md` names the 10-second auth-probe timeout but not the 5-second `which` timeout,
  which can also surface as `probe_failed` — `CliProbeFailureDetail` declares
  `'timeout:5000ms'` for exactly that case, and the contract does not mention it.
- A multi-CLI flow still stalls in silent N×10s increments with nothing on either stream while
  probes hang. Now at least documented; still surprising.
- `readProjectConfig` rejects every key outside `cli`/`executors`, so a conventional `"$schema"`
  key in `flows.json` is a hard `config_invalid`. *(carried)*

---

## What I could not verify

Nothing material. Unlike the previous round, the kernel suite **did** run this time, via
`ops/cargo.sh` (which sets a repo-local `CARGO_HOME`, sidestepping the unmounted-volume
`~/.cargo/registry` fault): **72 passed, 0 failed**, matching `ops/SCOREBOARD.md` exactly. The
SDK figure of 130 also matches. Both numbers on the scoreboard are honest.

I did not exercise the `signal:` path against a CLI killed by something other than `SIGSEGV`,
nor `flows check` on a filesystem where `which` is absent from `PATH` beyond the existing
empty-`PATH` fixture.

---

## Verdict

The three findings that blocked last round are closed, and closed properly rather than
argued away: M1 is pinned from both directions and I broke it twice to prove it; M2 and M3 I
reproduced live through the built binary, including the classified `detail` in the JSON
contract. The fix commit did what it said.

What remains splits cleanly into two piles, and neither warrants blocking:

- **Prospective traps** (N2, N3, N4, M4) — code that is correct as shipped but will silently
  produce a false message or a narrowed test the next time someone edits it. Last round rated
  M4 non-blocking for exactly this reason; consistency requires the same treatment here. All
  four are one-liners, and N3 in particular should not survive another round: a fall-through
  that renders "the probe timed out after on_denied" is the opposite of what M3 asked for.
- **Coverage gaps over behaviour I verified by hand** (N1, M5, M6, M7) — the suite would stay
  green if these broke, but they are not broken, and I checked rather than assumed.

Nothing in this PR produces a false `CHECK PASSED`, and nothing tells an operator something
false today — I ran the three messages that could. That is the bar this lens should hold, and
this tree clears it.

M8 is the one I would act on soonest even though it blocks nothing: five carried findings now
live only in superseded prose, and the record's growth is outpacing its usefulness.

**REVIEW_PASSED**
