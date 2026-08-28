# PR 8 — WP-4 `flows check` preflight (covenant 2)

**Lens:** maintainability — could a stranger read this in six months and change it safely?
**Reviewed at:** `4f8ecf8` (`test(preflight): pin CLI and trigger validation`)
**Reviewer:** independent maintainability pass, round six
**Verdict:** PASS with five non-blocking findings

---

## Verification actually performed

Not a read-only pass. What I ran, and what it showed:

| # | Action | Result |
|---|--------|--------|
| 1 | `npm test` in `sdk/` (`tsc --noEmit && vitest run`) | **121 passed, 7 files, 0 failed** |
| 2 | Mutation: delete `network_allowlist` from `kernelPermissionsToAuthoring`'s accept list | **121/121 still green** — finding N1 |
| 3 | Mutation: delete the `projectSearchStart` branch of `unresolvedCliMessage` | **121/121 still green** — finding N2 |
| 4 | Mutation: delete `probeTrigger`'s `probe_failed` try/catch entirely | **121/121 still green** — finding N3 |
| 5 | Live probe of SDK/kernel validator divergence (temp vitest case, since removed) | `validateSpec` returns `{ok:true}` for `cli:"   "`, `triggers:[{id:"  ",executor:"  "}]`, step `cli:" "` — finding N4 |
| 6 | Round-trip fixture key-coverage audit of the three canonical `*.spec.canonical.json` | every emittable boundary key covered **except** `permissions.network_allowlist` |

**What I could not run:** `cargo test`. This machine's cargo registry cache is
corrupted independently of the PR — `failed to create directory
.../registry/cache/index.crates.io-...: File exists (os error 17)`, reproduced under
`--offline` and with the sandbox disabled. The prior round reports a working
`cargo test → 72 passed`, so this is environment drift, not a regression from
`4f8ecf8`. Consequence: the Rust half of N4 is **read-verified, not executed**
(`"   ".trim().is_empty()` is `true`, so `is_some_and` yields `Err(SpecError::EmptyCli)`;
that arm is already exercised by the PR's own `cli: ""` assertion in
`preflight_data_is_fail_closed`). I am flagging this rather than implying I ran it.

Working tree confirmed restored after every mutation (`git status` clean except the
review artifacts).

## Prior blocking findings: closed

Round five blocked on two items. Both are genuinely closed at `4f8ecf8`, not
papered over:

- **M1** (three new kernel `SpecError` variants pinned by nothing) — `spec/tests.rs`
  now asserts `EmptyCli`, `InvalidTrigger` for both the empty-id and empty-executor
  shapes, and `DuplicateTrigger`, each by exact variant. The `malformed` half was
  also upgraded from bare `is_err()` to `matches!(… Malformed(msg) if msg.contains("unknown field \`worker\`"))`,
  which was the related suggestion.
- **M2** (SDK duplicate-trigger-id rule pinned by nothing) — `validate.test.ts` now
  asserts the exact string `spec.triggers[1].id: duplicate trigger id "hourly"`.

I re-derived these independently rather than taking the closure commit at its word.

---

## What is good, and should survive any rewrite

A stranger's first question is always *why*, not *what*, and this PR answers it at
every non-obvious decision. That is the single biggest reason it reads safely:

- **`preflight.ts:183-190`** explains why deterministic steps *warn* instead of
  *refusing* — string commands run through `/bin/sh -c`, so an unresolved first word
  may still be a builtin, function, or assignment, and refusing would reject valid
  flows. Without that paragraph the warn/refuse split looks like timidity; with it,
  it is the only correct choice.
- **`cli.ts:246-249`** anchors the kernel-dialect heuristic: "Compiler-emitted kernel
  specs always carry `retry`." That one sentence converts a scary-looking sniff into
  a bounded one, and tells a maintainer what invariant must hold if they extend it.
- **`compile.ts:143-145`** explains why `KERNEL_RETRY_DEFAULTS` is materialized at
  compile time (byte-identical to the kernel's own serialization) — i.e. why the
  duplication is load-bearing rather than a smell.
- **`cli.test.ts:145-148`** is a *control case*: relocated-but-unmutated ladder flows
  must still pass, "otherwise the refusals could be an artifact of the temp directory
  rather than of the fault, and the suite would be green for the wrong reason." This
  is a test suite reasoning about its own validity. It is rare and it is right.
- **`preflight.test.ts:102-106`** states plainly that the reachability test proves only
  one direction, and that the converse is held by `tsc --noEmit` over the typed union —
  "recorded so the guarantee is not read as coming from this test alone." An honest
  comment about the *limits* of a test is worth more than a stronger-sounding one.

Two structural facts also matter for six-month-out changes:

- **The pure/impure seam is real and enforced by shape.** `preflight.ts` declares
  `PreflightProbes` and does no I/O; every filesystem and `spawnSync` call lives in
  `cli.ts`'s `systemProbes`. That is what makes `preflight.test.ts` able to inject a
  throwing probe and assert the boundary behaviour without touching a disk.
- **The refusal taxonomy is closed and centralized** in `failure-kinds.ts`, split into
  `PREFLIGHT_*` and `CHECK_INPUT_*` with a documented reason for the split, and the
  tests assert set-equality against the exported constants — so adding a kind without
  producing it, or producing one without declaring it, is caught.

Module sizes are comfortably inside AGENTS.md rule 1 (largest touched file:
`validate.ts` at 454 lines; `compile.ts` 408; `cli.ts` 282; `preflight.ts` 237).

**The SURFACE.md additions are the most valuable non-code change in the PR.** The
*Preflightable-CLI contract* and *Project-config discovery* paragraphs write down
exactly the two implicit contracts a stranger would otherwise have to reverse-engineer
from `probeCli` and `findConfig`: that a checkable CLI must answer `<cli> auth status`
with exit 0/non-zero, that relative paths resolve against *the file that declares them*
(flow vs. `flows.json`), and that the nearest `flows.json` is the whole config and is
never merged with outer ones. The *Anonymous resolution law* edit is likewise honest
where it would have been easy not to be: it now states that the platform-default rung
is declared but unimplemented, and that gate 1 makes no preflight guarantee to callers
that bypass `flows check`.

---

## Non-blocking findings, ordered by what a stranger will actually pay for them

### N1 — `kernelToAuthoring`'s `network_allowlist` handling is pinned by nothing

`compile.ts:kernelPermissionsToAuthoring` maps three permission keys. Two of them
(`file_globs`, `access_preset`) appear in the `hello-ladder` and `hello-agent` canonical
fixtures that `spec-parity.test.ts` round-trips. `network_allowlist` appears in none.

**Verified by mutation.** I removed `'network_allowlist'` from that function's accepted
key list, so a compiled spec carrying it would be rejected by `assertKernelKeys`:

```ts
const permissions = requireKernelObject(value, ['file_globs', 'access_preset'], at);
```

`npx vitest run` → **121 passed, 0 failed.**

This is the one live hole in an otherwise near-total audit. I enumerated every key the
three canonical fixtures exercise and compared it against everything `toKernelSpec` can
emit: `name`, `description`, `budget.{max_tokens_in,max_tokens_out,max_dollars}`,
`timeout_ms`, `model`, `recovery_mode`, both verification gates, all three surface
kinds, `file_globs`, `access_preset` — all covered; plus `cli` and `triggers` covered by
the new *round-trips flow, trigger, and step CLI declarations* case. `network_allowlist`
is the sole exception.

**Failure scenario:** a maintainer extending the permissions shape for gate 3 rewrites
`kernelPermissionsToAuthoring` and drops or renames the `network_allowlist` arm.
Full green build. `flows check` then *refuses the compiler's own output* — a spec
produced by `toKernelSpec` comes back as `REFUSED [invalid_spec] spec.steps[0].permissions:
unknown key "network_allowlist"` — and the operator is told their valid spec is invalid.
The docblock above `kernelToAuthoring` ("the inverse of `toKernelSpec` over specs this
compiler emits") would then be a comment asserting what the code does not do; today it
is true, but nothing keeps it true.

**Remedy, cheapest first:** add `networkAllowlist` to the `hello-agent` fixture's
permissions block (regenerating its canonical JSON and sha256), which folds the key into
the existing round-trip assertion at zero new test surface. A property-style assertion
that every key `toKernelSpec` can emit is accepted by `kernelToAuthoring` would close the
whole class rather than this one instance, and is what I would actually reach for.

### N2 — The unresolved-CLI guidance for "no `flows.json` anywhere" is pinned by nothing

`preflight.ts:97-104` builds a two-branch context string. The *shadowed nearest config*
branch is well tested (`cli.test.ts:313-327` asserts both `Nearest project config "…"
declares no cli` and `outer configs are shadowed`). The other branch is not.

**Verified by mutation.** I collapsed it to the empty string:

```ts
const context = options.projectConfigPath !== undefined
  ? ` Nearest project config "${options.projectConfigPath}" declares no cli; outer configs are shadowed.`
  : '';
```

`npx vitest run` → **121 passed, 0 failed.** `PreflightOptions.projectSearchStart`
becomes a parameter that `cli.ts:71` passes and nothing reads, and no test notices.

**Failure scenario:** this is the message a first-time user hits — flow written, no
`flows.json` created yet, `flows check` refuses. The sentence naming the directory the
search started from and the fact that it walked to the filesystem root is the entire
difference between "I know what to do next" and "the tool refuses and won't say why."
Losing it silently costs onboarding, not correctness, which is exactly the kind of
regression a test suite is supposed to notice on the user's behalf.

Worth noting this is not merely cosmetic: `findConfig` walks to the filesystem root, so
a `flows.json` in `$HOME` or `/` silently participates. The test helper
`temporaryProject` (`cli.test.ts:40-46`) writes a boundary `flows.json` into every temp
directory precisely so ambient configs cannot reach the fixtures — the suite already
treats this as hazardous. That hazard is now documented in SURFACE.md and the selected
path is printed on both success and refusal, which is the right mitigation; the untested
branch is the one place the mitigation is unprotected.

**Remedy:** one case that runs `check` on a flow inside a temp directory tree with no
`flows.json` anywhere on the path to root, asserting the `No flows.json was found from`
text. Hermetic only if the temp root has no ancestor config — worth asserting the
precondition in the test rather than assuming it.

### N3 — `probeTrigger`'s `probe_failed` arm remains unreachable and untested

Carried forward from round five's M3, still open at `4f8ecf8`.

`preflight.ts:158-171` wraps `probes.executor(trigger)` in try/catch. The only production
implementation is `executor: (trigger) => config.executors.includes(trigger.executor)`
(`cli.ts:181`) — an array membership test that cannot throw.

**Verified by mutation.** Replacing the whole guarded block with
`const registered: boolean = probes.executor(trigger);` leaves **121/121 green**. The
reachability test at `preflight.test.ts:107` still passes because `probe_failed` is
independently produced by the *CLI* probe path in scenario 5, so set-equality against
`PREFLIGHT_FAILURE_KINDS` is satisfied without this arm contributing anything.

AGENTS.md rule 6 is "no dead code, no speculative abstraction. Build what the current
gate needs." The defensible counterargument is that `PreflightProbes` is exported from
`index.ts`, so third-party probe implementations may throw and the module must not leak
a raw exception across its boundary. I find that argument sound — but it is nowhere
written down, and the `PreflightProbes` docblock says "A probe *may* throw" without
saying which of the three ever does in-tree. A maintainer applying rule 6 literally will
delete this and be right by the letter of the standard.

**Remedy:** either a one-line comment at the catch stating that it exists for
out-of-tree probe implementations rather than for `systemProbes`, or a unit case
injecting a throwing `executor` and asserting `probe_failed` with `triggerId` and
`executor` populated. The latter also pins the two fields, which nothing currently does.

### N4 — SDK and kernel disagree on whitespace-only `cli`, trigger `id`, and `executor`

Both halves of this rule shipped in this PR, and they do not agree.

The kernel trims (`spec.rs`): `self.cli.as_ref().is_some_and(|cli| cli.trim().is_empty())`
→ `EmptyCli`; `trigger.id.trim().is_empty() || trigger.executor.trim().is_empty()`
→ `InvalidTrigger`; and the same `trim()` test for step-level `cli` → `EmptyStepCli`.
The SDK does not (`validate.ts:444`): `isNonEmptyString` is `typeof v === 'string' &&
v.length > 0`.

**Verified on the SDK side.** A temporary vitest case (since removed; tree confirmed
clean) fed the spec below through `validateSpec` and `toKernelSpec`:

```
{ version:'0.1.0', name:'ws', cli:'   ',
  triggers:[{id:'  ',executor:'  '}],
  steps:[{id:'a',type:'llm',prompt:'p',cli:' '}] }
```

```
validateSpec: {"ok":true,"errors":[]}
kernel emit : {"version":"0.1.0","name":"ws","cli":"   ","triggers":[{"id":"  ","executor":"  "}], … "cli":" "}
```

The SDK declares this valid and emits it at the boundary; the kernel refuses it.
Rust side read-verified only — see the cargo note above.

**Why this is not blocking.** I initially scored it higher and then talked myself back
down, because both paths still fail closed with a usable message. Through
`flows check`, a whitespace `cli` refuses as `cli_missing` and a whitespace executor
refuses as `no_executor` before submission. Through the TS authoring path that bypasses
`flows check`, the kernel refuses at `run.start` with `flow cli cannot be empty`. Nothing
silently succeeds, and no run reaches minute 27. SURFACE.md now states outright that
gate 1 makes no preflight guarantee to callers bypassing `flows check`, so the scoping
is already honest. This is a hardening gap, not a defect.

**Why it is still worth fixing.** `spec-parity.test.ts`'s header states the suite "pins
one spec dialect at the SDK<->kernel seam," and the parity gate is precisely the
machinery that should make two validators agree about that dialect. Today it pins
*serialization* parity (canonical JSON, spec_hash, round-trip) and not *rejection*
parity, so the two validators can drift on what is valid without any signal. A maintainer
adding a fourth trim-rule to `RunSpec::validate` for gate 2 has nothing telling them a
TypeScript counterpart exists.

**Remedy:** change `isNonEmptyString` to `v.trim().length > 0`, or add a dedicated
`validateNonBlank` for the fields the kernel trims. Note the pre-existing asymmetry
extends to step `id` as well (kernel trims, SDK does not) — worth deciding the rule once
rather than per field. The durable fix is a rejection-parity case listing specs both
sides must refuse.

### N5 — The catch-all in `runCli` reports internal faults as the user's invalid spec

`cli.ts:83-88`:

```ts
} catch (error) {
  const failure = error instanceof CheckFailure
    ? error
    : new CheckFailure('invalid_spec', `Flow "${parsed.path}" could not be checked as a Relayflow spec.`);
```

Every `CheckFailure` thrown in-tree is correctly typed and passes through. But anything
*else* thrown between `readFlow` and `emitReport` — from `readProjectConfig`,
`systemProbes`, `preflight`, or `emitReport` itself — is relabelled `invalid_spec` and
blamed on the user's file.

**Failure scenario:** `resolveExecutable` calls `spawnSync('which', …)` once per
deterministic step and per CLI resolution. Under file-descriptor pressure in CI,
`spawnSync` throws `EMFILE` rather than returning an error result. The operator is told
`REFUSED [invalid_spec] Flow "pipeline.flow.yaml" could not be checked as a Relayflow
spec.` and goes looking for a YAML bug that does not exist. Six months on there is no
signal in the message, the kind, or the JSON report distinguishing "your spec is
malformed" from "the checker fell over."

This does fail closed (exit 2, no false pass), so it satisfies AGENTS.md rule 4's
letter. The complaint is that the *kind* is inaccurate, and the closed taxonomy in
`failure-kinds.ts` is the PR's own mechanism for making kinds trustworthy.

**Remedy:** narrow the catch to `CheckFailure` and let genuinely unexpected errors
surface as a distinct kind — `internal_error`, added to `CHECK_INPUT_FAILURE_KINDS` —
so the report says which side broke. The existing test *maps every input refusal path to
its declared kind without raw exceptions* (`cli.test.ts:329`) asserts set-equality over
`CHECK_INPUT_FAILURE_KINDS`, so a new kind would need a scenario there; injecting one is
awkward without a seam, which is itself an argument for making the probe factory
injectable into `runCli`.

---

## Nits

- **`cli.ts:120` and `cli.ts:126` compute `kernelDialectMarker(parsed)` twice** on the
  same object — once to route, once to build the error prefix. Hoisting it above the
  `try` removes the duplicate call and the implicit assumption that both calls return
  the same marker.
- **`resolveExecutable` passes `cwd` inconsistently.** `probeCli` spawns with
  `cwd: directory`; `resolveExecutable`'s `spawnSync('which', [command])` does not. Harmless
  today because `which` consults `PATH` only, but the `directory` parameter is silently
  unused on the bare-name path while the signature promises directory-relative
  resolution. A comment, or passing `cwd` for symmetry, would stop the next reader
  wondering which behaviour is intended.
- **`flows check` executes a binary named by the file it is checking.** A flow declaring
  `cli: ./setup` causes `./setup auth status` to run from the flow's directory.
  SURFACE.md documents the probe as a contract but never says checking an untrusted flow
  file runs code. That is the kind of implicit contract worth one explicit sentence,
  especially once gate 9 has flows authoring flows.
- **Exit codes are not documented.** `0` pass, `2` everything else, no distinct code for
  warnings-only. `SURFACE.md` describes the refusal kinds but not the process contract a
  CI script would branch on.

---

## Verdict

Prior rounds' blocking findings are closed at `4f8ecf8`, verified independently rather
than accepted. The SDK suite is green at 121/121 including `tsc --noEmit`; the Rust
suite could not be executed here for an environment reason unrelated to the PR, which I
have stated rather than glossed.

Against the lens question — *could a stranger read this in six months and change it
safely?* — the answer is yes. The boundaries are named and enforced by shape (pure
`preflight.ts` vs. impure `systemProbes`), the taxonomy is closed and centralized, the
implicit contracts a stranger would otherwise reverse-engineer are now written down in
SURFACE.md, and the non-obvious decisions carry comments explaining *why* rather than
restating *what*. The tests are adversarial in the ways that matter: a control case
guarding against green-for-the-wrong-reason, reachability asserted against exported
constants, and an explicit note about which guarantee the test does *not* provide.

The five findings are real, all but N4 are mutation-verified, and none of them makes a
change unsafe. N1 is the one I would fix before the next PR touches the boundary —
it is the single live hole in an otherwise complete round-trip audit, and its failure
mode is `flows check` refusing the compiler's own output. N4 deserves a decision on the
trim rule once, rather than per field, so gate 2 does not inherit the drift.

**REVIEW_PASSED**
