# PR #8 — WP-4 `flows check` preflight (covenant 2) — maintainability review

- **Lens:** maintainability — could a stranger read this in six months and change it safely?
- **Reviewed tree:** `flow/drive-57e923c-08271542` @ `c8c15a0505e86147998a0cc758b17544330f8285`
- **Artifacts:** `/tmp/pr-8.diff` (8,624 lines), `/tmp/pr-8.json`
- **Read first:** `AGENTS.md`, `docs/RFC-0001-everything-is-a-relayflow.md`

## Verification actually performed

- `cd sdk && npm test` (`tsc --noEmit` + vitest): **118 passed, 0 failed**, 7 files.
- `cd kernel && cargo test`: **could not run in this environment** — `error: failed to
  create directory ~/.cargo/registry/cache/index.crates.io-…: File exists (os error 17)`.
  This is a local registry-state fault, not a defect in the PR; the Rust changes below
  were read, not executed. Reported per AGENTS.md ("unverified work is unfinished work").
- Mutation probes: eight targeted mutations applied to `sdk/src/preflight.ts`,
  `sdk/src/cli.ts` and `sdk/src/compile.ts`, each followed by a full vitest run and a
  `git checkout --` restore. Working tree restored and verified clean after each.
- Behavioural probes: `npx tsx sdk/src/cli.ts check …` run against six hand-built
  fixtures in throwaway directories, each with its own `flows.json` boundary.

## What is good, and should not be lost in a rewrite

- **Every new file is small and single-purpose** (AGENTS.md rule 1): `preflight.ts` 237,
  `cli.ts` 272, `failure-kinds.ts` 43. Nothing approaches the 500-line smell.
- **Preflight is pure.** `PreflightProbes` injects every environment fact, so the
  refusal predicates are testable without touching the filesystem, and the module doc
  comment states that contract explicitly. This is the single best decision in the PR:
  it is why `preflight.test.ts` can enumerate the whole taxonomy in 122 lines.
- **The failure taxonomy is closed and honestly documented.** `failure-kinds.ts` splits
  input refusals from preflight refusals, and `preflight.test.ts:102-107` records that
  the test proves *reachability* while the *converse* is held by `tsc --noEmit`. A
  reviewer is told exactly which guarantee comes from where, instead of being left to
  assume the test proves both.
- **The ladder-fault tests induce faults on the real canonical flows** and carry a
  relocation control (`cli.test.ts:98-106`) so a refusal cannot be an artifact of the
  temp directory. That control is the difference between a green suite and a green suite
  that means something.
- **The JSON report is pinned whole** (`cli.test.ts:138-169`), not spot-checked, so a
  field silently appearing or disappearing in `CheckReport` breaks a test.
- Mutation-checked: dropping step-level CLI precedence fails 7 tests; dropping
  `description` or `model` from `kernelToAuthoring` fails 4 each; shortening the CLI
  probe timeout fails 15. The core resolution and round-trip contracts are genuinely
  pinned.

---

## Blocking findings

### M1 — The gate that judges this PR is edited by the branch it is judging

`workflows/review-swarm.yaml` is modified by five commits on this branch
(`930f376`, `c839179`, `2bb2368`, `3d9b9ce`, `3293ff3`), interleaved with the review
transcripts that file produced. AGENTS.md, Rails: *"Never edit a gate that judges your
own work."* RFC §2 rule 4: *"a repair agent must never be able to edit the gate that
judges it — gate definitions are owned outside the mutating agent's write scope."*

Most of the edits are genuine hardening and I want that on the record: requiring a
committed transcript (`git cat-file -e "HEAD:$f"`), rejecting an empty transcript, and
pinning `reviewed-head` all make the gate stricter. But one edit **loosens the verdict
rule**:

```
- if grep -q "REVIEW_FAILED" "$f"; then          # any occurrence anywhere fails
+ verdict=$(tail -n 1 "$f" | tr -d '\r')         # only the final line counts
+ if [ "$verdict" = "REVIEW_FAILED" ]; then
```

**Failure scenario:** a reviewer writes a transcript whose body contains
`REVIEW_FAILED` — in a quoted example, or in a finding that argues a lens *should* have
refused — and ends the file with `REVIEW_PASSED`. Under the pre-PR rule the swarm
blocked; under the post-PR rule it passes. The change is defensible on its merits
(the old rule was a false-positive trap; this very transcript contains the token in its
body). What is not defensible is *where* it was made: the branch under review changed
the rule by which it is judged, mid-review. Six months from now, a stranger reading a
green swarm result on PR #8 cannot tell whether it measured the code or the relaxed
rule — which is precisely the failure mode RFC §2 rule 7 cites against vendor bots
("a merge bar that counts a green vendor check is measuring quota, not quality").

**Remedy, cheap and behaviour-preserving:** revert `workflows/review-swarm.yaml` on this
branch and land it as its own PR, judged by the pre-change swarm. The preflight work
stands on its own and does not depend on it.

### M2 — A doc comment asserts a sequencing the code does not enforce

`kernel/relayflowd-core/src/spec.rs:32-34`:

```rust
/// Default CLI for llm/agent steps. Preflight resolves step → flow →
/// project config before the kernel is asked to start a run.
pub cli: Option<String>,
```

`preflight()` has exactly one production caller in the repository — `runCli` in
`sdk/src/cli.ts:68` (verified by grep across `sdk/src`, `kernel`, `workflows`; the only
other hits are `preflight.test.ts`). Nothing on the `run.start` path calls it:
`JournalClient.runStart` (`sdk/src/journal-client.ts:166-168`) sends the spec straight
to the kernel, and the kernel's `RunSpec::validate` checks only that `cli` is non-empty
— never that it exists, resolves, or authenticates.

**Failure scenario:** a maintainer reads that comment, concludes the CLI has been proven
present and authenticated by the time a run starts, and writes the llm/agent executor
without a resolution failure path. The first run submitted through `run.start` — the
supported programmatic path — dies at minute 27 on the exact defect covenant 2 exists to
prevent (RFC §1: *"an unknown `cli: grok` passed `--dry-run` and killed the run 27
minutes in"*).

This is a comment/scope defect, not necessarily a missing feature: it is legitimate for
gate 1 to ship preflight as a surface-side command. But then say so. Reword the comment
to state what is true (*"Declared for preflight; `flows check` resolves step → flow →
project config. The kernel does not resolve or probe it, and `run.start` does not
preflight — gate N owns that"*), and record the same limitation in `docs/SURFACE.md`
next to the preflightable-CLI contract, which currently reads as though the guarantee is
unconditional (*"a missing/unauthenticated resolution refuses at submit"* — true of
`flows check`, not of submit).

### M3 — Dialect autodetection hijacks an authoring typo, and the resulting error names nothing

`sdk/src/cli.ts:239-256` (`isKernelSpec`) routes a whole document to the kernel dialect
if *any* step carries one of five snake_case marker keys. `sdk/src/validate.ts:20-24`
still carries this comment about the authoring path:

> a typo'd key like `depends_on` must be an error naming the nearest valid key, never a
> silently discarded field

The new routing makes that comment false for the key it names as its own example.

**Failure scenario (reproduced):** an author writes authoring YAML, correctly uses
`timeoutMs` on one step, and typos `dependsOn` as `depends_on` on another.

```
version: '0.1.0'
name: mixed
steps:
  - id: first
    type: deterministic
    command: printf one
    timeoutMs: 5000
  - id: second
    type: deterministic
    command: printf two
    depends_on: [first]
```

```
$ npx tsx sdk/src/cli.ts check mixed.flow.yaml
REFUSED [invalid_spec] compiled spec contains an unknown or malformed object
exit=2
```

No file, no step index, no key name, no suggestion — and the real mistake (`depends_on`)
is not the key that triggered the refusal (`timeoutMs` is). Rename the typo to
`dependson` and the *same author* gets the good message:
`spec.steps[1]: unknown key "dependson" — did you mean "dependsOn"?`.

Two adjacent problems in one message string, both from `compile.ts`:
`requireKernelObject` / `assertKernelKeys` throw the single literal
`'compiled spec contains an unknown or malformed object'` for **every** structural
failure at **every** depth — root, step, verification, budget, permissions. Checking a
canonical spec with an unknown root key and one with an unknown step key produces
byte-identical output (verified). RFC covenant 1: *"Error messages name the author's
mistake in the author's vocabulary, never engine internals."* This message is neither.

**Remedy:** thread an `at` path through `requireKernelObject`/`assertKernelKeys` and name
the offending key, mirroring what `validate.ts` already does well; and when a document is
routed to the kernel dialect on a marker key, say so in the refusal
(*"read as compiled kernel spec because steps[1].depends_on is present"*) so the author
can see why their camelCase field became an error.

---

## Non-blocking findings

### M4 — The one refusal path that only the real probe can produce is untested

`sdk/src/cli.ts:189` — `if (result.error !== undefined) throw new Error('probe failed');`
is what turns a spawn failure into `probe_failed`. **Deleting that line leaves all 118
tests green** (mutation-verified). With the line gone, a spawn error (`ETIMEDOUT`,
`EACCES`, `ENOMEM`) falls through to `result.status === 0` → `status` is `null` →
`authenticated: false`, and the operator is told their CLI *failed authentication* when
it was never executed. `preflight.test.ts:113` covers the injected-throw path through the
pure predicate, but nothing covers the boundary that produces the throw. A test that
points `cli` at a non-executable file, or at a script that blows the 10 s timeout, would
pin the kind mapping. Given that a closed, correct failure taxonomy is the whole point of
covenant 2, the taxonomy's system-boundary edge deserves a test.

### M5 — `firstCommandWord`'s quoting branches are untested

`sdk/src/preflight.ts:234-237` handles `"…"` and `'…'` first words. **Replacing the whole
regex with `/^([^\s]+)/` leaves all 118 tests green** (mutation-verified). Either add a
fixture with a quoted command path (the case the branch exists for — a CLI path with a
space) or delete the branches per AGENTS.md rule 6. As written, a stranger cannot tell
whether the quoting support is load-bearing or leftover.

### M6 — The `command_unresolved` message is wrong for the case the backlog already flags

`sdk/src/preflight.ts:183-190` justifies warning-instead-of-refusing for *all*
deterministic commands: *"an unresolved first word may still be a shell builtin,
function, or assignment — refusing would reject valid flows."* That argument does not
apply to a path-like word, and `ops/BACKLOG.md:6-10` says so explicitly ("Refuse a
path-like deterministic command word (contains `/`) when that path does not exist").
The deferral is honest; the comment is not, because it does not mention the carve-out it
is deferring. The emitted message is worse:

```
$ npx tsx sdk/src/cli.ts check p.flow.yaml   # command: ./definitely-not-here.sh --go
WARNING [command_unresolved] Step "run" command "./definitely-not-here.sh" does not
  resolve as an executable; it runs only if the shell supplies it.
CHECK PASSED
```

The shell cannot "supply" `./definitely-not-here.sh`; that step is going to fail. One
sentence in the doc comment ("path-like words *are* provable — see BACKLOG") keeps the
next reader from concluding the current behaviour is the intended endpoint.

### M7 — `maxConcurrency: 1` is load-bearing for correctness, enforced only by a comment

`workflows/review-swarm.yaml:17-20` drops concurrency 3 → 1 because the three lenses now
`git commit` into a shared index. The DAG was also rewired into a chain
(`lens-history dependsOn: [lens-maintainability]`, `lens-structure dependsOn:
[lens-history]`), so the serialization is expressed twice, in two mechanisms, for one
reason. A future maintainer optimising wall-clock — three independent lenses, why are
they serial? — will raise `maxConcurrency` and hit index corruption, because the only
thing stopping them is a comment. Either make the dependency chain the single expression
of the constraint (and note *why* the chain exists on the `dependsOn` lines), or have
each lens write to a scratch path and let `aggregate` perform one commit.

Related duplication: the 9-line commit protocol (`Set TRANSCRIPT to …` through
`git cat-file -e`) is now copy-pasted verbatim into all three lens prompts, differing
only in the lens name. Three copies of one protocol will drift; the next change to the
evidence rules has to be made three times, correctly, or the swarm silently enforces
different rules per lens.

### M8 — Extra positional arguments are refused but untested

`sdk/src/cli.ts:98` refuses `positionals.length !== 1`. **Adding `.slice(0, 1)` to the
positional filter leaves all 118 tests green** (mutation-verified): `flows check a.yaml
b.yaml` would silently check only `a.yaml` and report `CHECK PASSED` while the operator
believes both were checked. The guard is correct today; nothing holds it there.

### M9 — SURFACE.md's nested-boundary claim has an unstated hole

`docs/SURFACE.md` (project-config discovery): *"A nearer config therefore defines a
self-contained nested project boundary and prevents accidental inheritance of outer
credentials or executors."* `findConfig` (`sdk/src/cli.ts:157-171`) selects the first
`flows.json` that passes `accessSync(…, R_OK)`. A nearer `flows.json` that exists but is
unreadable (mode 000, or on a mount with restrictive permissions in CI) is silently
skipped, and the outer config wins — the exact inheritance the sentence promises to
prevent, with no diagnostic. The preceding sentence does say "first readable", so the
behaviour is disclosed; the guarantee sentence next to it is not qualified. Either
qualify it, or treat an unreadable-but-present `flows.json` as `config_invalid` rather
than as absent.

### M10 — The kernel/authoring round-trip is a six-site hand-maintained contract

Adding one field to the spec requires coordinated edits in: `sdk/src/spec.ts` (authoring
interface *and* kernel interface), `sdk/src/validate.ts` (`ROOT_KEYS` /
`STEP_TYPE_KEYS`), `sdk/src/compile.ts` (`compileStep`, `toKernelSpec`,
`kernelToAuthoring`'s `unionKeys` *and* its per-type `typeKeys`), `kernel/…/spec.rs`
(struct + `STEP_*_FIELDS`), and a `testdata` fixture. The design is fail-closed — a
forgotten `kernelToAuthoring` entry throws rather than dropping data — and the current
field set is well covered (dropping `description` or `model` from `kernelToAuthoring`
fails 4 tests each). Two things would make this safe for a stranger: (a) the failure
surfaces as M3's opaque message, so the person who forgets an entry gets no hint what
they forgot; (b) `kernelToAuthoring`'s doc comment says it is "the inverse of
`toKernelSpec` over specs this compiler emits", which is the right contract, but no test
enforces the inverse over the *type* — only over three fixtures. A short note in
`compile.ts` listing the sites to touch would pay for itself the first time someone adds
a field.

---

## Verdict

The preflight core — a pure, probe-injected predicate module with a closed, typed,
reachability-tested failure taxonomy, in three small files — is good work and reads
cleanly. Three things block:

- **M1**: the branch under review edits the gate that judges it, including a loosening of
  the verdict rule. Rails violation with a cheap, behaviour-preserving remedy.
- **M2**: a kernel doc comment asserts a preflight-before-`run.start` sequencing that no
  code enforces, at exactly the seam covenant 2 exists to close.
- **M3**: an authoring typo silently reroutes the document into the kernel dialect and
  produces an error that names no file, step, or key — breaking covenant 1's
  error-message rule and falsifying `validate.ts`'s own comment about that same key.

None of the three require a design decision; all three are localized edits.

reviewed-head: c8c15a0505e86147998a0cc758b17544330f8285
REVIEW_FAILED
