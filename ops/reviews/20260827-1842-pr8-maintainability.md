# PR #8 — maintainability review (round three)

**PR:** `WP-4 — flows check preflight (covenant 2)`
· branch `flow/drive-57e923c-08271542` · <https://github.com/AgentWorkforce/flows/pull/8>
**Lens:** maintainability — could a stranger read this in six months and change it safely?
**Reviewer:** independent maintainability lens (Claude)
**Date:** 2026-08-27 18:42

---

## 1. What I read and what I ran

Read first, as instructed: `AGENTS.md`, `docs/RFC-0001-everything-is-a-relayflow.md`
(covenant 1 and 2, §96 gate-1 done-when, settled decisions #13/#14).

Then the diff (`/tmp/pr-8.diff`, 49 files) and the working tree for every file it
touches: `sdk/src/preflight.ts`, `sdk/src/cli.ts`, `sdk/src/failure-kinds.ts`,
`sdk/src/compile.ts`, `sdk/src/spec.ts`, `sdk/src/validate.ts`, `sdk/src/index.ts`,
all four touched test files, `kernel/relayflowd-core/src/spec.rs`,
`kernel/relayflowd-core/tests/spec_parity.rs`, `kernel/relayflowd/src/exec_det.rs`,
every fixture under `testdata/preflight/`, `docs/SURFACE.md`, and
`workflows/review-swarm.yaml`.

**Executed, not inferred:**

| What | Result |
|---|---|
| `npm test` in `sdk/` (`tsc --noEmit && vitest run`) | **106 passed, 0 failed**, 7 files |
| `cargo test` (whole kernel workspace) | **72 passed, 0 failed** across 9 suites |
| 4 scratch probes (3 vitest, 2 cargo), each deleted after running | see findings |

> Environment note, not a finding against this PR: `cargo` is unusable as
> configured on this machine — `~/.cargo/registry` is a symlink into
> `/Volumes/Paris Drive/…`, which is not mounted, so dependency resolution fails
> with `File exists (os error 17)`. I ran the Rust half under
> `CARGO_HOME=/tmp/cargo-review-home`. Anyone reproducing these results needs the
> same override or a remounted volume.

I read the five prior PR #8 transcripts *after* forming my own findings, to
separate what is new from what is carried. Findings **F1, F2, F3, F4** below are
new. §5 records what is carried and what has closed.

---

## 2. Verdict in one line

The preflight module itself is the best-factored code in this repo — pure,
injected, closed taxonomy, honest comments. The **boundary translation layer
added alongside it (`kernelToAuthoring`, `triggers`, dialect detection) is not
held to the same standard**, and two of its gaps are the kind that a stranger in
six months would not find until they cost a debugging day. Two blocking.

---

## 3. Blocking findings

### F1 — `triggers: []` makes the SDK and the kernel compute different `spec_hash` values, at the exact seam this PR adds

**Blocking. Verified on both sides.**

`spec.rs:37` declares the new field as

```rust
#[serde(default, skip_serializing_if = "Vec::is_empty")]
pub triggers: Vec<TriggerSpec>,
```

while `compile.ts:164` (`toKernelSpec`) emits it unconditionally when present:

```ts
...(flow.triggers !== undefined ? { triggers: flow.triggers } : {}),
```

Nothing on either side rejects an empty array: `validate.ts:163` (`validateTriggers`)
iterates zero entries and returns clean; `spec.rs:73` iterates zero triggers and
returns clean. So `triggers: []` is a *valid spec on both sides* that the two
sides serialize differently.

**SDK half** (`compileYamlToCanonicalJson` / `compileAndHash`, run under vitest):

```
CANON : {"name":"t","steps":[…],"triggers":[],"version":"0.1.0"}
HASH  : 16dd960d1777a0a203d6d9940f9e0b29728dc02374c45d80059049c9ba07c516
```

**Kernel half** (`RunSpec::parse` → `validate` → re-serialize, exactly what
`spec_parity.rs:64-70` documents as "precisely what the engine hashes when it
stamps `spec_hash` in `run.spawned`"), run under `cargo test`:

```
KERNL : {"name":"t","steps":[…],"version":"0.1.0"}
```

which hashes to `e36be728cddbd4312072757fd40d6184ba9c70476e74b123b25b1b012bfabb78`.

Two different `spec_hash` values for one spec. `spec_parity.rs` calls itself the
gate that makes "one spec dialect, one hash" a tested fact — and it does not
catch this, because all three fixtures (`hello-ladder`, `hello-llm`,
`hello-agent`) omit `triggers` entirely. The gate is green and the property is
false.

**Why this matters beyond a hash mismatch.** RFC settled decision #14 makes the
content-addressed digest the provenance mechanism: "every journal records exactly
which flow version produced it", "triggers bind to digests". A `flows build` that
emits `16dd96…` while `run.spawned` stamps `e36be7…` breaks provenance for
precisely the flows that *have* triggers — the resident/scheduled class the RFC
identifies as the 2026-08-27 workerless-run failure family.

**Why it reads as an oversight rather than a decision.** The surrounding code
applies exactly the guard this field is missing. `toKernelStep` (`compile.ts:339-345`)
emits `surfaces` only when non-empty:

```ts
const surfaces = { ...(step.surfaces?.workspace?.length ? {…} : {}), … };
if (Object.keys(surfaces).length > 0) out.surfaces = surfaces;
```

because `spec.rs:253` skips `AgentSurfaces::is_empty`. The same author wrote the
same guard for the same reason two fields away. `triggers` is the one new field
that skipped it. A stranger reading `toKernelSpec` will see the surfaces guard
and reasonably assume the pattern is applied uniformly.

**Failure scenario.** A generator — sage, gate 9 self-authoring, or a flow
template — emits `triggers: []` for a flow with no triggers, which is the
natural thing for a code generator to do. `flows check` passes. `flows build`
seals the bundle at `flow@sha256:16dd96…`. The kernel spawns the run and journals
`spec_hash: e36be7…`. No error anywhere; the provenance chain is simply wrong,
and it is wrong only for flows produced by a generator, so it will show up first
in the self-authoring path where it is hardest to attribute.

**Fix (small).** Either drop the empty array on the SDK side —

```ts
...(flow.triggers?.length ? { triggers: flow.triggers } : {}),
```

matching the surfaces guard — or remove `skip_serializing_if` from `spec.rs:37`.
Either way, add a fixture with `triggers: []` to the parity pair so the property
is tested rather than assumed. Given `#[serde(default)]` on the kernel side, I'd
take the SDK-side guard: it normalizes at the compiler, which is where every
other emptiness decision in this file already lives.

---

### F2 — `kernelToAuthoring` silently discards a declared `retry` policy, while its own doc comment and this PR's structure review both call the round-trip lossless

**Blocking. Verified.**

`compile.ts:196-199` documents the new function as:

```ts
/**
 * Map the kernel boundary dialect back to the normalized authoring shape.
 * This is the inverse of `toKernelSpec` for flows returned by `compileSpec`.
 * Unknown keys and malformed kernel-only policy fields fail closed.
 */
```

`retry` is in the allowed key set (`compile.ts:213`) and is validated
(`validateKernelRetry`, `compile.ts:249`) — and then never copied into the
returned object. `common` (`compile.ts:231-240`) carries `id`, `type`,
`dependsOn`, `maxIterations`, `verification`. Not `retry`.

**Reproduced** (vitest scratch, deleted after running) — a spec whose retry policy
is well-formed but not the default:

```
INPUT  retry: {"initial_backoff_ms":5,"max_backoff_ms":9,"multiplier":7,"jitter_percent":3}
AFTER  kernelToAuthoring: {"version":"0.1.0","steps":[{"id":"a","type":"deterministic",
       "maxIterations":1,"verification":{"type":"exit_code"},"command":"printf hi"}]}
BACK   toKernelSpec(compileSpec(…)): retry:{"initial_backoff_ms":100,
       "max_backoff_ms":60000,"multiplier":2,"jitter_percent":20}
```

The declared policy is gone and has been replaced by the defaults. Silently. No
warning, no refusal, exit 0.

**Three things are wrong here, and they compound:**

1. **The comment asserts what the code does not do.** "This is the inverse of
   `toKernelSpec`" is true only for the subset of inputs `toKernelSpec` itself
   produces, and the comment does not say so. "Malformed … policy fields fail
   closed" is true; well-formed *non-default* ones fail **open and silent**, which
   is the more dangerous case and the one the comment leaves a reader confident
   about.
2. **It contradicts the rule stated 100 lines away in the same codebase.**
   `validate.ts:41-44`, unchanged by this PR:
   > "Validation is fail-closed on unknown keys (AGENTS.md rule 4; RFC covenant 2):
   > a typo'd key … must be an error naming the nearest valid key, **never a
   > silently discarded field**"

   AGENTS.md rule 4 is "Fail closed… No silent fallbacks." Substituting the
   default retry policy for a declared one is a silent fallback.
3. **The false claim is already propagating into the repo's record.** This PR's
   own structure transcript, `ops/reviews/20260827-1836-pr8-structure.md:38`,
   states: *"`spec-parity.test.ts` pins the round-trip
   `kernelToAuthoring(toKernelSpec(flow)) === flow`, so the boundary dialect is
   lossless."* It is not lossless. That sentence is now committed evidence, and
   the next author has no reason to doubt it.

**Why the test cannot catch it.** `spec-parity.test.ts:41-44` asserts
`kernelToAuthoring(toKernelSpec(flow))` deep-equals `flow`. `toKernelStep`
(`compile.ts:355`) hardcodes `retry: { ...KERNEL_RETRY_DEFAULTS }` for every
step, so the round-trip test can only ever feed the default policy in. This is
precisely a test that would not fail if the behavior broke — it pins the
identity of a constant, not the fidelity of a translation.

**Fix.** Gate 1 has no authoring surface for `retry`, so carrying it into the
authoring shape would be speculative (AGENTS.md rule 6). The fail-closed move is
right: have `validateKernelRetry` reject any policy that is not
`KERNEL_RETRY_DEFAULTS`, with a message naming the field — a compiled spec whose
retry differs from what this compiler emits was not produced by this compiler,
and `flows check` should say so rather than pretend it read it. Then correct the
doc comment to state the actual domain ("the inverse over specs this compiler
emits; anything else is refused"), and add a non-default-retry case to the test.

---

## 4. Non-blocking findings

### F3 — dialect detection is an undocumented two-key sniff; it misroutes valid kernel specs and then answers in the wrong vocabulary

`cli.ts:226-229`:

```ts
function isKernelSpec(value: unknown): boolean {
  if (!isObject(value) || !Array.isArray(value['steps'])) return false;
  return value['steps'].some((step) => isObject(step) && ('depends_on' in step || 'max_iterations' in step));
}
```

Both sentinel keys are `#[serde(default)]` on the kernel side (`spec.rs:202-206`:
`depends_on` → `[]`, `max_iterations` → `default_max_iterations()`). A
kernel-dialect spec that omits both is therefore fully valid to the kernel and
invisible to this sniff.

**Both halves verified.** The kernel accepts it (`cargo test` scratch):

```
KERNEL ACCEPTS: {"name":"hand","steps":[{"command":"printf hi","depends_on":[],
"id":"a","max_iterations":1,"retry":{…},"type":"deterministic","verification":{}}],
"version":"0.1.0"}
```

`flows check` refuses the same bytes (vitest scratch, exit 2):

```
REFUSED [invalid_spec] spec.steps[0]: unknown key "retry"
  (expected one of id | type | dependsOn | verification | maxIterations | timeoutMs | command);
  spec.steps[0].verification.type: expected exit_code | output_contains | json_schema
```

The author wrote a legal kernel spec and is told that `retry` — a required field
of the dialect they are writing — is an unknown key, and is offered the *other*
dialect's key list as the correction. Covenant 1: *"Error messages name the
author's mistake in the author's vocabulary, never engine internals."* This
message names a mistake the author did not make, in a vocabulary they did not
choose.

I am filing this non-blocking because the realistic input today is the SDK's own
canonical JSON, which always carries both keys. It will stop being non-blocking
the moment anyone hand-trims a compiled spec, and `flows check`'s own usage
string advertises `<flow.yaml|spec.json>` as a first-class input.

Two secondary maintainability points on the same nine lines: the heuristic has
**no test** (nothing in `sdk/tests/` constructs an ambiguous spec) and **no
comment** saying why those two keys were chosen or what happens when neither is
present. A stranger changing the kernel dialect — adding a field, or adding a
`skip_serializing_if` to `depends_on` — would have no way to know they had
silently moved this boundary.

**Fix.** Sniff on the full set of kernel-only keys
(`retry`, `depends_on`, `max_iterations`, `timeout_ms`, `recovery_mode`,
`command` as array, snake_case at the root), or try authoring first and fall back
to kernel, reporting whichever error set belongs to the dialect that matched
more keys. Either way: a comment stating the rule, and a test for a spec that
carries neither sentinel.

---

### F4 — the swarm aggregate will accept a *previous round's* transcript as this round's verdict

`workflows/review-swarm.yaml:153`:

```sh
f=$(ls -1 ops/reviews/*-pr${PR}-${lens}.md 2>/dev/null | sort | tail -1)
```

The M7 fix (mtime → lexicographic `sort`) is correct and closes the ordering bug.
It does not close the staleness class, because **nothing binds a transcript to
the run that is judging the code**. The selector asks "what is the newest file
matching this glob", never "was it produced against this HEAD".

**Demonstrated in this repository, right now.** Before I wrote this file, the
aggregate's own selector returned:

```
maintainability -> ops/reviews/20260827-1829-pr8-maintainability.md   (REVIEW_FAILED)
history         -> ops/reviews/20260827-1838-pr8-history.md           (REVIEW_PASSED)
structure       -> ops/reviews/20260827-1836-pr8-structure.md         (REVIEW_PASSED)
```

The maintainability entry is from the *previous* round — written before commit
`2bb2368`, which is part of the code under review. It is committed, non-empty,
and carries a clean verdict token, so it satisfies every check the aggregate
performs (`-s`, `git cat-file -e`, `tail -n 1`).

**Failure scenario.** A lens step times out (`timeoutMs: 1800000`) or its harness
dies before writing. It produces no new transcript. The aggregate finds the prior
round's file, reads `REVIEW_PASSED`, prints `ok: <lens> passed`, and — if the
other two also passed — emits `SWARM_PASSED`. A merge is gated on a review of
code that no longer exists. Note the asymmetry: today the stale file happens to
say `REVIEW_FAILED`, which fails safe by luck. Reverse the round order and the
same mechanism passes a PR nobody reviewed.

This matters more than an ordinary CI nit because this workflow *is* the review
gate for this repo (AGENTS.md: "Branch, PR, wait for review"), and its own header
says it exists because "external bots are not review signal". A gate that can
report on stale evidence has the same defect it was built to route around.

**Fix (small, fits the existing shape).** Have each lens stamp the commit it
reviewed into its transcript —

```sh
echo "reviewed-head: $(git rev-parse HEAD)" >> "$TRANSCRIPT"
```

— and have the aggregate refuse any transcript whose recorded head is not the
current `HEAD`, with the same `SWARM_FAILED: <lens> reviewed a different commit`
message shape the other four checks already use. That turns "the newest file"
into "the transcript for this code", which is what the comment on line 147-148
already claims the check does: *"A missing transcript is a refusal too: an
unpersisted verdict is not evidence."* A transcript for the wrong commit is not
evidence either.

---

### F5 — `--json` is a machine-facing contract with no exported type, no schema, and no version field

`--json` exists so a caller can parse the report (`cli.ts:54-55`: *"a caller
parsing stdout gets a report either way"*), and `emitReport` correctly keeps
stdout clean by routing all human lines to stderr. But `CheckReport`
(`cli.ts:23-28`) is a **non-exported** interface. `cli.ts` exports exactly
`CliIo` and `runCli`; `index.ts` re-exports `preflight`, every diagnostic type,
and all three kind constants — but not the report shape those diagnostics arrive
in. A CI consumer must hand-roll the type, exactly as `cli.test.ts:131` does:

```ts
const report = JSON.parse(result.stdout.join('\n')) as { diagnostics: Array<{ kind: string }> };
```

That inline cast is also the only thing pinning the JSON shape. Rename
`resolutions`, drop `path`, or nest `diagnostics`, and every SDK test still
passes while every external consumer breaks. The field is also typed by
indirection — `resolutions: ReturnType<typeof preflight>['resolutions']`
(`cli.ts:26`) — when `CliResolution` is exported from `preflight.ts` and could
just be imported; the indirection makes the report shape harder to read than it
needs to be for the one type in the file a stranger most needs to understand.

Compounding: the report still does not name the `flows.json` it used (carried
M3), so the one question a `--json` consumer most wants answered — "where did
this CLI come from?" — remains unanswerable from the machine output.

**Fix.** Export `CheckReport` from `cli.ts`, re-export from `index.ts`, and add a
test that asserts the full top-level key set rather than one nested field.

---

### F6 — carried and still open: `probe_failed` is the only refusal kind whose real producer is never exercised

`grep -rn probe_failed sdk/tests` → nothing. Every `probe_failed` in the suite
comes from an injected throwing probe (`preflight.test.ts:113`). Its sole real
producer is `cli.ts:179` — `spawnSync` setting `result.error` on a 10 s timeout or
an `EACCES`. Filed in round one, filed again in round two, not in WP-5's scope.

The asymmetry is worth naming precisely: the four other refusal kinds are each
driven end-to-end through the real `systemProbes` by a committed fixture
(`cli-missing`, `cli-unauthenticated`, `cli-unresolved`, `no-executor`) *and*
through induced faults on the canonical ladder flows. `probe_failed` — the kind
that exists specifically to handle real-I/O failure — is the one that never meets
real I/O. A hanging fixture (`#!/bin/sh` + `sleep 30`) plus a shortened probe
timeout would close it, at the cost of one slow test.

---

## 5. Carried, closed, and checked-clear

**Closed since round two, verified:**

- **M1 / CLI path resolution.** `docs/SURFACE.md:80` now states the rule
  explicitly — a path resolves relative to the file that declares it, the flow
  for step/flow-level `cli`, the project config for a `flows.json` default; a bare
  name via `PATH`. `cli.ts:165` implements exactly that, and `cli.test.ts:179-194`
  pins the project-relative case with a real on-disk fixture. Doc and code agree.
- **M2 / `FlowSpec.name`.** `spec.ts:164` is now `name?: string`, matching
  `spec.rs:28` (`Option<String>`). Type and validator agree. The *reason* — SDK↔kernel
  parity — is not stated at the declaration; one clause there would spare the
  next reader the cross-repo lookup, but this is a nit, not a finding.
- **M5 / M6 / M7 (swarm).** `fetch` now runs under `set -eu` with explicit
  `-s` checks on both artifacts (`review-swarm.yaml:48-58`); the aggregate reads
  `tail -n 1` rather than grepping the whole transcript (line 163), so a review
  that *discusses* the token is no longer scored as a rejection; selection is
  lexicographic rather than mtime (line 153). All three mechanisms are fixed.
  F4 above is the residue of M7's class, not a reopening of M7 itself.
- **M3, partially.** The config ascent is no longer wholly unexecuted —
  `cli.test.ts:179-194` puts `flows.json` one directory above the flow. The
  second half (the report never names the config file it used) is still open; see F5.

**Checked and clear — I went looking and found nothing wrong:**

- **The `/bin/sh -c` claim is accurate.** `preflight.ts:167-174` justifies warning
  rather than refusing on an unresolved deterministic command word by citing
  `exec_det.rs`. Verified: `kernel/relayflowd/src/exec_det.rs:24-25` does
  `Command::new("/bin/sh").args(["-c", script])`. The reasoning holds. (One
  wrinkle for a future reader: `exec_det.rs:32` also supports an **array** command
  that bypasses the shell entirely, a shape `DeterministicStepSpec.command:
  string` cannot express. `flows check` refuses it cleanly — verified, exit 2,
  `REFUSED [invalid_spec] spec.steps[0].command: expected a non-empty string` — so
  it fails closed. But the comment cites `exec_det.rs` as its authority while
  covering only half of what that file does.)
- **No other empty-collection parity divergence.** I audited every
  `skip_serializing_if` in `spec.rs` (28 of them) against what `toKernelSpec`
  emits. `AgentSurfaces` and its three `Vec` fields are guarded by
  `?.length` checks and `Object.keys(surfaces).length > 0`; `permissions`,
  `budget`, and every `Option` field round-trip identically. `triggers` (F1) is
  the sole divergence.
- **The warning taxonomy is genuinely closed and genuinely tested.**
  `failure-kinds.ts:23-28` states the three-state invariant — resolved / did not
  resolve / could not be probed, and *"silence is not one of the states"* — and
  `preflight.test.ts:75-85` drives all three with `toEqual` on the full diagnostic
  array, so an extra or missing warning fails. That is a comment and a test that
  agree, which is the standard the rest of this PR should be held to.
- **The reachability/converse split is honest.** `preflight.test.ts:102-106`
  states plainly that the test proves reachability and that the converse is held
  by the typed union plus `tsc --noEmit` in `npm test`. Verified `npm test` does
  run `tsc --noEmit` (`package.json`). A comment that declines to overclaim.
- **The induced-fault control is real.** `cli.test.ts:92-96` relocates each
  ladder flow *without* mutating it and asserts it still passes, so the refusals
  at line 98-105 cannot be an artifact of the temp directory. This is the single
  best test-design decision in the PR and the comment at 88-91 says exactly why
  it exists.
- **Exit-code and stream discipline.** 0 pass / 2 refuse, uniformly; diagnostics
  always to stderr, JSON alone to stdout. `--json` is honoured even when the
  invocation itself failed (`cli.ts:56-58`).
- **`--help` is not handled** (`runCli(['check','--help'])` → exit 2,
  `invalid_invocation`). Covenant 1 adjacent, but the usage string *is* the error
  message, so the author still learns the right thing. Nit, not a finding.

---

## 6. What is genuinely good here

Recording this because it should survive the two blockers, and because the next
author should copy it rather than regress it.

`preflight.ts` is the module this repo should be measured against. 221 lines,
one purpose, zero I/O — the `PreflightProbes` interface (`preflight.ts:20-25`) is
carried by a one-line comment that states the whole contract: *"Environment facts
are injected; this module performs no I/O."* Every environment fact enters through
three injected predicates, which is why the unit tests can drive all five refusal
kinds and all three warning kinds without touching a filesystem, and why `cli.ts`
can be a thin composition root that owns `spawnSync`/`which`/`accessSync` and
nothing else. That separation is what AGENTS.md rule 2 asks for, applied on the
SDK side where the rule does not even formally reach.

The failure taxonomy is a closed `as const` union split into two honestly-named
halves — `PREFLIGHT_FAILURE_KINDS` (the pure predicates) and
`CHECK_INPUT_FAILURE_KINDS` (refusals that happen before those predicates can
run) — with the union derived rather than restated. Adding a kind is one edit and
`tsc` finds every site.

`cli.test.ts:196-219` is the test I'd most want to keep: it drives all four input
refusal paths through the real CLI, asserts the produced kinds equal
`CHECK_INPUT_FAILURE_KINDS` **as a set**, asserts the two halves reconstitute the
whole, and asserts no `SyntaxError` leaks. It fails if a kind is added and left
unreachable *and* if a raw exception starts escaping.

And the `Preflightable-CLI contract` paragraph added to `docs/SURFACE.md` is the
right instinct exactly where this review is otherwise complaining: it takes an
implicit contract (`<cli> auth status`, exit 0 = healthy) and writes it down,
including what preflight deliberately does *not* do — "never sends a prompt,
never spends a token, never invokes any other subcommand." The same paragraph
also volunteers that the platform-default rung is declared but unimplemented and
that reaching it refuses with `cli_unresolved` rather than guessing. That is a
doc telling on its own code, which is the behavior this lens exists to reward.

F1, F2 and F3 are all the same shape: the boundary-translation code did not get
the treatment the preflight code got. The standard is already set inside this
PR — it just needs to be applied to `compile.ts` and `isKernelSpec` too.

---

## 7. Verdict rationale

**F1** is a broken parity property with a green gate over it, on the field this PR
exists to add, feeding the digest mechanism RFC #14 makes provenance depend on.
**F2** is a silent fallback contradicting AGENTS.md rule 4 and `validate.ts`'s own
stated rule, wrapped in a comment that tells the next reader the opposite, and
already re-asserted as fact in a committed transcript in this same PR. Both are
small, mechanical fixes — a `?.length` guard and an equality check — and both are
the kind of thing that becomes very expensive to find later, which is the whole
question this lens is asked to answer.

Everything in §4 is real and should be filed; none of it needs to block.

Fix F1 and F2 (each ~3 lines plus a fixture/test), correct the `kernelToAuthoring`
doc comment to state its actual domain, and note the correction to
`20260827-1836-pr8-structure.md:38` so the "lossless" claim does not stand
unchallenged in the record. This is a strong PR with two loose screws in the
newest joint.

REVIEW_FAILED
