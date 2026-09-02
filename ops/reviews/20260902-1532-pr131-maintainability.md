# PR #131 — maintainability & test-quality review (round 3)

- **Lens:** maintainability and test quality — *could a stranger safely change this in six
  months, and would the tests tell them if they broke it?*
- **PR:** #131 — `feat(release): build verified Cloud v2 runtime artifact`
- **Exact head reviewed:** `de3cf47ba8ea70b1f9bcf39008849afe561f83ea`
- **Base / merge base:** `origin/main` @ `51415d9c65ef5c727c560c700f63932893a1e224`
- **Prior failed rounds read in full:**
  `ops/reviews/20260902-1501-pr131-maintainability.md` (G1),
  `ops/reviews/20260902-1501-pr131-history.md` (H1),
  `ops/reviews/20260902-1512-pr131-structure.md` (S1)
- **Constitution read in full:** `AGENTS.md`, `docs/RFC-0001-everything-is-a-relayflow.md`
- **Date:** 2026-09-02
- **Mode:** assessment only. No product file was modified, merged, or pushed. Every mutation
  and compilation ran against copies in `/tmp/pr131-maint3.OVweYT/` and `/tmp/pr131-maint3-mut/`.
  `sdk/` dependencies were reached by symlinking a sibling worktree's `node_modules` into the
  `/tmp` copy, specifically so this tree gained no `node_modules` and no `dist/`.

---

## Verdict up front

**REVIEW_PASSED.**

Three rounds produced two blocking findings. Both are closed at this head, and I closed them by
execution rather than by reading the diff:

- **G1 / H1 — the packaged `flows` was a silent no-op.** Fixed twice over: a dedicated
  unconditional entry module, *and* a smoke assertion that makes the failure mode structurally
  un-green. I compiled both the old and the new entry with the CI-pinned bun and ran them.
- **S1 — `verifyArtifactDirectory` ELF-checked only `relayflowd`.** Fixed and mutation-verified;
  the shared verifier now owns the complete executable contract, which I proved by deleting the
  builder-side prechecks and watching the build still refuse.

The remaining five findings are non-blocking and recorded below. None of them can silently
resurrect the defect this round was about, which is the property I was checking for.

---

## 0. Scope confirmation

```
$ pwd
/Users/khaliqgant/AgentWorkforce/flows-v2-artifact-wt

$ git rev-parse HEAD
de3cf47ba8ea70b1f9bcf39008849afe561f83ea

$ git merge-base origin/main HEAD
51415d9c65ef5c727c560c700f63932893a1e224

$ git log --format='%H %s' origin/main..HEAD
de3cf47ba8ea70b1f9bcf39008849afe561f83ea fix(release): execute and verify packaged flows CLI
303f39f8133cda94aa1061604eba7cff58c0df25 fix(release): harden v2 Cloud artifact contract
46ce1623e99f43d06a692cb49d657ef602c1b096 feat(release): build verified Cloud v2 runtime artifact

$ git diff --name-status origin/main...HEAD
A	.github/workflows/cloud-runtime-artifact.yml
A	scripts/cloud-artifact.mjs
A	scripts/cloud-artifact.test.mjs
A	sdk/src/cli-executable.ts

$ gh pr view 131 --json number,headRefOid,baseRefOid,state,title
{"baseRefOid":"51415d9c65ef5c727c560c700f63932893a1e224","headRefOid":"de3cf47ba8ea70b1f9bcf39008849afe561f83ea","number":131,"state":"OPEN","title":"feat(release): build verified Cloud v2 runtime artifact"}
```

The PR head is the reviewed head. The repair commit is small and single-purpose:

```
$ git show --stat de3cf47 | tail -6
 .github/workflows/cloud-runtime-artifact.yml | 12 ++++++++++--
 scripts/cloud-artifact.mjs                   |  1 +
 scripts/cloud-artifact.test.mjs              | 14 ++++++++++++++
 sdk/src/cli-executable.ts                    | 12 ++++++++++++
 4 files changed, 37 insertions(+), 2 deletions(-)

$ git diff --check 51415d9c65ef5c727c560c700f63932893a1e224..de3cf47ba8ea70b1f9bcf39008849afe561f83ea; echo "exit=$?"
exit=0
```

Suite as shipped, at this head:

```
$ node --test scripts/cloud-artifact.test.mjs
✔ builds and verifies the exact Linux x64 Cloud artifact contract (73.818958ms)
✔ verification fails after a manifested runtime file is tampered (68.304666ms)
✔ outer checksum mismatch fails before extraction (41.247708ms)
✔ verification rejects files not declared by the manifest (65.9595ms)
✔ verification rejects a declared file missing from the artifact (62.985875ms)
✔ verification rejects a manifest path that escapes the artifact root (74.532208ms)
✔ verification rejects an absolute manifest path (56.007541ms)
✔ verification rejects a relayflowd whose declared bytes are not Linux x64 ELF (58.562833ms)
✔ verification rejects a flows executable whose declared bytes are not Linux x64 ELF (65.931917ms)
✔ verification rejects a required binary whose execute mode was stripped (55.805042ms)
✔ verification rejects a required executable omitted by the manifest contract (66.33675ms)
✔ manifest pins journal protocol version zero (40.060792ms)
✔ CLI rejects a misspelled build option in artifact vocabulary (135.946875ms)
✔ CLI reports a missing verify option before touching the filesystem (89.876375ms)
ℹ tests 14
ℹ suites 0
ℹ pass 14
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1136.694125
```

---

## 1. G1 / H1 — the unconditional standalone CLI entry — **REPAIRED**

The workflow now compiles a dedicated entry module instead of the guarded library module
(`.github/workflows/cloud-runtime-artifact.yml:49`), and `sdk/src/cli-executable.ts` calls
`runCli` unconditionally:

```ts
import { runCli } from './cli.js';

async function main(): Promise<void> {
  process.exitCode = await runCli(process.argv.slice(2));
}

void main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
```

### 1a. Executed, old shape against new shape

I compiled both entries with the same bun the workflow pins, changing only the target to the
host so the binaries would run here. `sdk/` was copied to `/tmp` first; this worktree was not
written to.

```
$ bun --version
1.4.0

$ tmp="$(mktemp -d /tmp/pr131-maint3.XXXXXX)"; cp -R sdk "$tmp/sdk"
$ ln -s /Users/khaliqgant/AgentWorkforce/flows-g2-analyzer-wt/sdk/node_modules "$tmp/sdk/node_modules"

$ bun build "$tmp/sdk/src/cli-executable.ts" --compile --target=bun-darwin-arm64 --outfile="$tmp/flows-new"
  [76ms]  bundle  86 modules
 [228ms] compile  /tmp/pr131-maint3.OVweYT/flows-new

$ bun build "$tmp/sdk/src/cli.ts" --compile --target=bun-darwin-arm64 --outfile="$tmp/flows-old"
  [24ms]  bundle  85 modules
 [197ms] compile  /tmp/pr131-maint3.OVweYT/flows-old
```

The new entry runs, and it **fails closed**:

```
=== NEW entry: happy path ===
exit=0 stdout_bytes=534
STDOUT: {"ok":true,"path":"testdata/hello-deterministic.flow.yaml","projectConfigPath":"/Users/khaliqgant/AgentWorkforce/flows-v2-artifact-wt/testdata/flows.json","resolutions":[],"diagnostics":[{"severity":"warning","kind":"unprovable_effects","stepId":"greet","message":"Step \"greet\" command \"echo\" resolves, but its effects cannot be proven before execution."},{"severity":"warning","kind":"unprovable_effects","stepId":"shout","message":"Step \"shout\" command \"echo\" resolves, but its effects cannot be proven before execution."}]}
STDERR:
WARNING [unprovable_effects] Step "greet" command "echo" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "shout" command "echo" resolves, but its effects cannot be proven before execution.

=== NEW entry: nonexistent flow (fail-closed check) ===
exit=2
stdout: {"ok":false,"path":"testdata/does-not-exist.flow.yaml","resolutions":[],"diagnostics":[{"severity":"refusal","kind":"input_unreadable","message":"Flow \"/Users/khaliqgant/AgentWorkforce/flows-v2-artifact-wt/testdata/does-not-exist.flow.yaml\" is not readable."}]}
stderr: REFUSED [input_unreadable] Flow "/Users/khaliqgant/AgentWorkforce/flows-v2-artifact-wt/testdata/does-not-exist.flow.yaml" is not readable.

=== NEW entry: garbage subcommand ===
exit=2
stdout_bytes=0 stderr: REFUSED [invalid_invocation] Usage: flows check [--json] <flow.yaml|spec.json> flows run [--json] [--data-dir <dir>] <flow.yaml|spec.json> flows resume [--json] [--data-dir <dir>] <run-id> flows hn-monitor start [--data-dir <dir>] [--poll-interval-ms <n>] <spec.json>

=== OLD entry (cli.ts --compile): the prior defect, for contrast ===
exit=0
stdout_bytes=0 stderr_bytes=0
old nonexistent-flow exit=0
```

The old shape is still inert at this head — the guard was not "fixed", it was *bypassed by a
new entry*, which is the correct call: `sdk/src/cli.ts` stays import-safe for
`sdk/tests/bin.test.ts` and the npm `bin`, and the packaged binary gets an entry with no guard
to fail. Exit `2` with a `REFUSED [input_unreadable]` diagnostic is the covenant-2 typed
failure the artifact is supposed to carry.

### 1b. No double-invocation, and the npm entry did not regress

`cli-executable.ts` imports `cli.js`, whose self-executing guard still exists. If that guard
ever evaluated true under the new entry, the CLI would run twice. It does not:

```
=== node dist/cli-executable.js (new entry under plain node) ===
exit=0
json_report_count=1
=== node dist/cli-executable.js on a bad flow (fail-closed) ===
exit=2
REFUSED [input_unreadable] Flow ".../testdata/does-not-exist.flow.yaml" is not readable.
=== node dist/cli.js (npm bin entry, unchanged) ===
exit=0 json_report_count=1

$ ./node_modules/.bin/tsc --noEmit; echo "typecheck exit=$?"
typecheck exit=0
```

### 1c. The smoke step now asserts output — mutation-verified

This is the part that matters more than the entry fix, because it is what stops the next
regression of this shape. I extracted the literal smoke fragment from
`.github/workflows/cloud-runtime-artifact.yml:75-83` into a script, ran it under `bash -e` (the
Actions default shell), and substituted the binary:

```
===== A. real repaired binary (expect pass) =====
smoke exit=0

===== B. inert no-op binary — the 303f39f defect (expect FAIL) =====
smoke exit=1
SyntaxError: Unexpected end of JSON input

===== C. binary reporting ok:false (expect FAIL) =====
smoke exit=1
  if (report.ok !== true) throw new Error("flows smoke report was not ok");

===== D. binary reporting ok:true for the WRONG path (expect FAIL) =====
smoke exit=1
    throw new Error(`flows smoke reported unexpected path: ${report.path}`);
```

Case B is the exact prior defect — a binary that exits `0` and prints nothing — and the gate
kills it. The previous round's complaint was "the step cannot distinguish *the CLI works* from
*the CLI does nothing*"; it now can, and it also rejects a wrong verdict (C) and a wrong subject
(D). Worth noting the capture is clean by construction: diagnostics go to `stderr` via
`emitDiagnostics` (`sdk/src/cli.ts:195-202`) and only the report reaches `stdout`, so
`JSON.parse` is not racing warning text.

### 1d. The exact-head CI run proves it end to end

```
$ gh api repos/AgentWorkforce/flows/actions/runs/33636230943 --jq '{head_sha,event,status,conclusion}'
{"conclusion":"success","event":"pull_request","head_sha":"de3cf47ba8ea70b1f9bcf39008849afe561f83ea","status":"completed"}

$ gh api repos/AgentWorkforce/flows/actions/runs/33636230943/jobs --jq '.jobs[].steps[] | "\(.conclusion)\t\(.name)"'
success	Test artifact contract
success	Build relayflowd
success	Build standalone flows CLI
success	Assemble artifact and smoke verifier path
success	Smoke exact Linux artifact
success	Run actions/upload-artifact@v4
```

The packaged Linux binary emitted a real report — the thing that was missing last round:

```
$ gh run view 33636230943 --log | grep -oE '\{"ok":true,"path":"testdata/hello-deterministic.flow.yaml".*'
{"ok":true,"path":"testdata/hello-deterministic.flow.yaml","projectConfigPath":"/home/runner/work/flows/flows/testdata/flows.json","resolutions":[],"diagnostics":[{"severity":"warning","kind":"unprovable_effects","stepId":"greet",...}]}
```

The before/after is unambiguous:

```
$ gh run view 33636230943 --log | grep -c '"ok":true'     # this head
1
$ gh run view 33631974128 --log | grep -c '"ok":true'     # prior head 303f39f
0
```

Provenance and the compiled entry are both stamped from the exact head:

```
$ gh run view 33636230943 --log | grep -oE '"sourceCommit":"[0-9a-f]{40}"|Artifact relayflow-v2-linux-x64-[0-9a-f]{40} has been successfully uploaded' | sort -u
"sourceCommit":"de3cf47ba8ea70b1f9bcf39008849afe561f83ea"
Artifact relayflow-v2-linux-x64-de3cf47ba8ea70b1f9bcf39008849afe561f83ea has been successfully uploaded

$ gh run view 33636230943 --log | grep -oE 'bun build sdk/src/[a-z-]+\.ts' | sort -u
bun build sdk/src/cli-executable.ts

$ gh run view 33636230943 --log | awk -F'\t' '$2=="Test artifact contract"{print $3}' | grep -E 'tests |pass |fail '
# tests 14
# pass 14
# fail 0
```

G1 and H1 closed.

---

## 2. S1 — symmetric ELF enforcement — **REPAIRED (mutation-verified)**

`verifyArtifactDirectory` now checks both required executables
(`scripts/cloud-artifact.mjs:118-119`), and the suite gained the symmetric regression
(`scripts/cloud-artifact.test.mjs:133-145`).

I mutated a `/tmp` copy one guard at a time, restoring from a hash-verified pristine copy each
round. The pristine copy is byte-identical to the reviewed file:

```
$ shasum -a 256 pristine.mjs /Users/khaliqgant/.../scripts/cloud-artifact.mjs
bd9c0d8c7e7c8bfb960bbec1b904ac593dbbf467ef3109ff72efaef9814e6275  pristine.mjs
bd9c0d8c7e7c8bfb960bbec1b904ac593dbbf467ef3109ff72efaef9814e6275  /Users/khaliqgant/.../scripts/cloud-artifact.mjs
```

```
----- MUTATION: M8 remove verify-side ELF check on bin/flows (the S1 repair) -----
119d118
<   await assertLinuxX64Elf(join(root, 'bin', 'flows'), 'flows');
✖ verification rejects a flows executable whose declared bytes are not Linux x64 ELF (63.957958ms)
ℹ tests 14
ℹ pass 13
ℹ fail 1
restored: bd9c0d8c7e7c8bfb960bbec1b904ac593dbbf467ef3109ff72efaef9814e6275  cloud-artifact.mjs

----- MUTATION: M9 remove verify-side ELF check on bin/relayflowd -----
118d117
<   await assertLinuxX64Elf(join(root, 'bin', 'relayflowd'));
✖ verification rejects a relayflowd whose declared bytes are not Linux x64 ELF (68.121625ms)
ℹ tests 14
ℹ pass 13
ℹ fail 1
restored: bd9c0d8c7e7c8bfb960bbec1b904ac593dbbf467ef3109ff72efaef9814e6275  cloud-artifact.mjs

=== restored copy passes clean ===
ℹ tests 14
ℹ pass 14
ℹ fail 0
```

Each mutant kills exactly one test and the *right* one. That is the test-quality property I
care about here: the two guards are independently pinned, not jointly covered by an overlapping
assertion. The new test's regex is deliberately discriminating — `/flows must be a little-endian
Linux x86-64 ELF binary/u` does not match the `relayflowd must be …` message, so it cannot pass
on the wrong guard's failure.

**The shared verifier now genuinely owns the contract**, which was the structural half of S1. I
verified this rather than assuming it: with both builder-side prechecks
(`scripts/cloud-artifact.mjs:32-33`) deleted, the build *still* refuses a non-ELF `flows`,
because `buildCloudArtifact` runs `verifyArtifactDirectory` on the stage at `:48`.

```
----- M10: remove BOTH builder-side ELF prechecks (:32-33), keep only the shared verifier -----
32,33d31
<   await assertLinuxX64Elf(relayflowd);
<   await assertLinuxX64Elf(flowsExecutable, 'flows');
ℹ tests 14
ℹ pass 14
ℹ fail 0
--- does a build with a non-ELF flows still fail, via the shared verifier at :48? ---
RESULT: build REJECTED -> flows must be a little-endian Linux x86-64 ELF binary
```

M10 is an *equivalent mutant*, and that is the good news, not a coverage hole: the builder
checks are now redundant preflight over a verifier that cannot be bypassed. The structure
review's stated requirement — "the final shared verifier must own the complete artifact
contract" — holds. S1 closed.

---

## 3. Non-blocking findings

### N1 — MEDIUM — `cli-executable.ts` does not say why it exists

The entire reason this file is separate from `cli.ts` is that `isDirectInvocation` cannot hold
under `bun build --compile` (`process.argv[1]` is a `/$bunfs/` path `realpathSync` cannot stat).
That reason appears nowhere in the file, and the file has exactly one consumer in the whole
repo:

```
$ grep -rn "cli-executable" --include='*.ts' --include='*.yml' . | grep -v node_modules | grep -v make-cli
./.github/workflows/cloud-runtime-artifact.yml:49:          bun build sdk/src/cli-executable.ts \
```

To a stranger this reads as a redundant duplicate of `cli.ts`'s tail, and "consolidating" it
away is the obvious cleanup — which silently restores the inert binary. This is precisely the
non-obvious *why* that AGENTS.md says a comment is for.

It is non-blocking because the smoke assertion from §1c makes the resurrection loud: deleting
this file and pointing the workflow back at `cli.ts` fails the job on `SyntaxError: Unexpected
end of JSON input`. The guard is structural; the comment would just save the reader the trip.

### N2 — MEDIUM — the smoke asserts the happy path only

`bin.test.ts` — the surface this repo grew *because of* the PR #8 entrypoint incident — asserts
both directions: `CHECK PASSED` on a good flow and `REFUSED [cli_missing]` at exit 2 on a bad
one. The packaged standalone gets only the positive half; nothing in CI asserts that the
shipped binary refuses.

I confirmed by hand that it does refuse (§1a: exit `2`, `REFUSED [input_unreadable]`), so this
is a coverage gap rather than a defect. A negative case needs `|| true` under `bash -e` to
capture a nonzero exit, which is presumably why it was skipped. Worth adding while the file is
open, since fail-closed (AGENTS.md §4) is the property this PR has now been rejected over twice.

### N3 — LOW — the `#!/usr/bin/env node` shebang on `cli-executable.ts` is inert

`tsc` emits it into `dist/cli-executable.js`, but `make-cli-executable.mjs` only chmods
`dist/cli.js`, and `package.json` `bin` still maps `flows` → `./dist/cli.js`:

```
$ ls -l dist/cli.js dist/cli-executable.js
-rw-r--r--  ... dist/cli-executable.js
-rwxr-xr-x  ... dist/cli.js
$ head -1 dist/cli-executable.js
#!/usr/bin/env node
$ node -e "console.log(JSON.stringify(require('./package.json').bin))"
{"flows":"./dist/cli.js"}
```

A shebang on a non-executable, unmapped file is decoration that implies a launch path that does
not exist — and `files: ["dist","src"]` means it ships. Either wire it up or drop the line.

### N4 — LOW — `REQUIRED_EXECUTABLES` is not the single source of truth for the ELF contract

```
$ grep -n "REQUIRED_EXECUTABLES\|assertLinuxX64Elf" scripts/cloud-artifact.mjs
24:const REQUIRED_EXECUTABLES = ['bin/flows', 'bin/relayflowd'];
114:  for (const required of REQUIRED_EXECUTABLES) {
118:  await assertLinuxX64Elf(join(root, 'bin', 'relayflowd'));
119:  await assertLinuxX64Elf(join(root, 'bin', 'flows'), 'flows');
190:async function assertLinuxX64Elf(path, executableName = 'relayflowd') {
```

The list drives the manifest-declaration check at `:114` but not the ELF check at `:118-119`.
Adding a third required executable gets the declaration check for free and the platform check
never — which is the same asymmetry S1 was, one executable later. `executableName =
'relayflowd'` as a default parameter compounds it: both call sites are known, so the default
only exists to let a future third call site inherit the wrong name silently. Looping
`REQUIRED_EXECUTABLES` and making the name required would collapse both.

### N5 — LOW, carried — `protocolVersion` is still hand-copied three times

Unchanged from the prior round's R2, and now stable rather than drifting:

```
$ grep -rn "protocolVersion" scripts/
scripts/cloud-artifact.test.mjs:180:    assert.equal(built.manifest.protocolVersion, '0');
scripts/cloud-artifact.mjs:127:    protocolVersion: '0',
scripts/cloud-artifact.mjs:146:    value.protocolVersion !== '0' ||

$ grep -n "PROTOCOL_VERSION" sdk/src/protocol.ts
15:export const PROTOCOL_VERSION = 0 as const;
```

The three copies can no longer drift from each other, but none is connected to the SDK
constant, so an SDK bump to `1` still ships an artifact claiming `"0"` with all 14 tests green.
Protocol v0 is current, and RFC-0001 §7 leaves versioning open, so this is a recorded aging risk,
not a defect.

### N6 — LOW, carried — temp archive leaks on `tar` failure

`scripts/cloud-artifact.mjs:50-54` writes `.relayflow-v2-<commit>-<pid>.tar.gz.tmp` into
`outputDir`; the `finally` at `:63-65` removes only `stageParent`. A failed `tar` leaves the
partial file behind. CI's `find -name '*.tar.gz'` will not match it, so this is litter, not a
correctness problem.

---

## 4. What is good and should survive

- **The repair is minimal and targeted.** 37 insertions across four files, each traceable to a
  specific finding. No opportunistic refactor rode along.
- **The fix is defended twice, at different layers.** The entry module makes the binary work;
  the smoke assertion makes a broken binary fail the job. Only the second one survives a future
  author who does not know this history — and the reviewer that rejected round 2 was right to
  say the assertion matters more than the guard.
- **The right seam was chosen.** `cli.ts` stays import-safe, so `bin.test.ts` and the npm `bin`
  path are untouched; the packaging concern lives in a packaging-specific module. That is a
  cleaner boundary than weakening the guard in shared code would have been.
- **Test naming stayed disciplined.** The new case is named for the property it defends, and
  M8/M9 prove the names are honest — each kills its own test and nothing else.
- **Module sizes remain well inside AGENTS.md §1:** `92` / `273` / `252` / `12` lines.
- **Whitespace-clean diff, and the exact-head job is green on its own merits**, not on a
  vendor check — CodeRabbit is rate-limited and per RFC-0001 §2 rule 7 is not review signal.

---

## Verdict

The two blocking findings that failed rounds 2 and 3 are closed, and I closed them the way
AGENTS.md asks: by running the literal commands and pasting what came back, including the
old-shape contrast that shows the defect was real and the mutants that show the new gates bite.
The packaged `flows` executes, reports, and refuses; the shared verifier enforces the platform
contract on both binaries and is now the sole owner of it; and the exact head's CI emitted the
report that the prior head silently omitted.

The six remaining items are maintainability polish and carried aging risks. None of them can
turn this artifact back into a silent no-op without a red CI job.

REVIEW_PASSED
