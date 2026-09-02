# PR #131 — maintainability review (round 2)

- **Reviewer lens:** maintainability — *could a stranger safely understand and change this in six months?*
- **PR:** https://github.com/AgentWorkforce/flows/pull/131 — "feat(release): build verified Cloud v2 runtime artifact"
- **Exact head reviewed:** `303f39f8133cda94aa1061604eba7cff58c0df25`
- **Base:** `main` @ `51415d9c65ef5c727c560c700f63932893a1e224`
- **Prior round:** `ops/reviews/20260902-1435-pr131-maintainability.md` (REVIEW_FAILED at `46ce162`)
- **Date:** 2026-09-02
- **Constitution read in full:** `AGENTS.md`, `docs/RFC-0001-everything-is-a-relayflow.md`
- **Mode:** assessment only. No product code was modified. Every mutation and experiment ran
  against **copies** in `/tmp/pr131-mut2/`, `/tmp/pr131-bun/`, `/tmp/pr131-sdk/`. The repo
  working tree was never edited; `sdk/` dependencies were installed into a `/tmp` copy
  specifically to avoid writing `node_modules` or a migrated lockfile into the tree.

---

## Verdict up front

**F1, F2, F3 and F4 are all genuinely repaired.** I re-ran the prior round's mutation battery
and every mutant that survived at `46ce162` is now killed. That work is real and I want it
recorded as such before the rest.

**But the fix commit introduced a new blocking defect.** The change that closed F7 — replacing
the `node` shim with a `bun build --compile` standalone binary — ships a `bin/flows` that is a
**silent no-op**. It produces no output and exits `0` for every input, including inputs it is
required to refuse. The green CI smoke step cannot see this because it only checks exit codes,
and the exit code is always zero.

`REVIEW_FAILED` — on G1 below, not on F1–F4.

---

## 0. Scope confirmation

```
$ git rev-parse HEAD
303f39f8133cda94aa1061604eba7cff58c0df25

$ gh pr view 131 --json number,headRefOid,baseRefName,state,title
{"baseRefName":"main","headRefOid":"303f39f8133cda94aa1061604eba7cff58c0df25","number":131,"state":"OPEN","title":"feat(release): build verified Cloud v2 runtime artifact"}

$ git show --stat 303f39f
 .github/workflows/cloud-runtime-artifact.yml |  23 ++--
 scripts/cloud-artifact.mjs                   |  61 +++++++---
 scripts/cloud-artifact.test.mjs              | 172 +++++++++++++++++++++++++--
 3 files changed, 219 insertions(+), 37 deletions(-)

$ gh pr checks 131
CodeRabbit	pass	0		Review rate limited
linux-x64-artifact	pass	2m50s	https://github.com/AgentWorkforce/flows/actions/runs/33631974128/job/100253372584
```

Suite as shipped, at this head:

```
$ node --test scripts/cloud-artifact.test.mjs
✔ builds and verifies the exact Linux x64 Cloud artifact contract (104.36475ms)
✔ verification fails after a manifested runtime file is tampered (73.467042ms)
✔ outer checksum mismatch fails before extraction (45.230542ms)
✔ verification rejects files not declared by the manifest (69.896458ms)
✔ verification rejects a declared file missing from the artifact (68.234417ms)
✔ verification rejects a manifest path that escapes the artifact root (76.010458ms)
✔ verification rejects an absolute manifest path (70.478958ms)
✔ verification rejects a relayflowd whose declared bytes are not Linux x64 ELF (71.427791ms)
✔ verification rejects a required binary whose execute mode was stripped (69.296334ms)
✔ verification rejects a required executable omitted by the manifest contract (72.655541ms)
✔ manifest pins journal protocol version zero (44.819916ms)
✔ CLI rejects a misspelled build option in artifact vocabulary (140.856083ms)
✔ CLI reports a missing verify option before touching the filesystem (135.31375ms)
ℹ tests 13
ℹ pass 13
ℹ fail 0
```

---

## Part 1 — F1 through F4 repair verification

### F1 — provenance SHA — **REPAIRED**

`.github/workflows/cloud-runtime-artifact.yml:22-26` now pins the checkout, and `:54-62`
passes the same SHA through `SOURCE_COMMIT` instead of `git rev-parse HEAD`.

The proof is not the diff, it is the run. From the CI log of the passing job on this head:

```
$ gh run view 33631974128 --log | grep -i sourceCommit
linux-x64-artifact	Assemble artifact and smoke verifier path	{"archivePath":".../relayflow-v2-303f39f8133cda94aa1061604eba7cff58c0df25-c2d775cbeee76232-linux-x64.tar.gz",...,"manifest":{"schemaVersion":1,"protocolVersion":"0","sourceCommit":"303f39f8133cda94aa1061604eba7cff58c0df25","platform":"linux","arch":"x64",...}}
```

That SHA is the PR head, and unlike the merge ref recorded last round it is a real, reachable object:

```
$ git cat-file -t 303f39f8133cda94aa1061604eba7cff58c0df25
commit

$ git merge-base --is-ancestor 303f39f8133cda94aa1061604eba7cff58c0df25 origin/feat/v2-cloud-artifact && echo "reachable from PR branch"
reachable from PR branch
```

The event really was `pull_request`, so this is the trigger that was broken before:

```
$ gh api repos/AgentWorkforce/flows/actions/runs/33631974128 --jq '{head_sha,event,status,conclusion}'
{"conclusion":"success","event":"pull_request","head_sha":"303f39f8133cda94aa1061604eba7cff58c0df25","status":"completed"}
```

`git checkout <sourceCommit>` now works for a holder of this tarball. F1 closed.

*Tradeoff worth naming, not a defect:* pinning `ref:` to the head SHA means this job no longer
builds or tests the post-merge state. For an artifact-provenance job that is the right call —
you want the SHA you stamp to be the SHA that exists — but a stranger should know that a
semantic conflict with `main` will not surface here.

### F2 — unpinned guards — **REPAIRED (mutation-verified)**

I re-ran the prior round's battery against copies, one mutation at a time, restoring from a
hash-verified pristine copy each round.

```
$ cp scripts/cloud-artifact.mjs scripts/cloud-artifact.test.mjs /tmp/pr131-mut2/
$ cd /tmp/pr131-mut2 && cp cloud-artifact.mjs pristine.mjs && shasum -a 256 pristine.mjs
9b2ea8368d6d5adafa4aa936dbd64910ad376e06e6f5faa534230d848a0d7af9  pristine.mjs
```

Every mutant that survived last round now dies:

| Mutation | Guard removed | Prior round | This round |
|---|---|---|---|
| M1 | archive-contents-must-match-manifest (`:99-101`) | survived | **killed** — 2 tests fail |
| M2 | manifest path-traversal + absolute rejection (`:158-159`) | survived | **killed** — 2 tests fail |
| M3 | ELF guard in `verifyArtifactDirectory` (`:118`) | survived | **killed** — 1 test fails |
| M4 | required-executables check (`:114-117`) | survived | **killed** — 1 test fails |
| M5 | `protocolVersion` `'0'`→`'99'`, writer *and* reader | survived | **killed** — 1 test fails |
| M6 | real execute-mode check (`:109-112`) — new code | n/a | **killed** — 1 test fails |

Captured failures, in order:

```
----- MUTATION: M1 remove archive-contents-must-match-manifest check -----
✖ verification rejects files not declared by the manifest
✖ verification rejects a declared file missing from the artifact
ℹ tests 13
ℹ pass 11
ℹ fail 2
restored: 9b2ea8368d6d5adafa4aa936dbd64910ad376e06e6f5faa534230d848a0d7af9  cloud-artifact.mjs

----- MUTATION: M2 remove manifest path-traversal rejection -----
✖ verification rejects a manifest path that escapes the artifact root
✖ verification rejects an absolute manifest path
ℹ tests 13
ℹ pass 11
ℹ fail 2
restored: 9b2ea8368d6d5adafa4aa936dbd64910ad376e06e6f5faa534230d848a0d7af9  cloud-artifact.mjs

----- MUTATION: M3 remove ELF platform guard from verifyArtifactDirectory -----
✖ verification rejects a relayflowd whose declared bytes are not Linux x64 ELF
ℹ tests 13
ℹ pass 12
ℹ fail 1
restored: 9b2ea8368d6d5adafa4aa936dbd64910ad376e06e6f5faa534230d848a0d7af9  cloud-artifact.mjs

----- MUTATION: M4 remove required-executables check -----
✖ verification rejects a required executable omitted by the manifest contract
ℹ tests 13
ℹ pass 12
ℹ fail 1
restored: 9b2ea8368d6d5adafa4aa936dbd64910ad376e06e6f5faa534230d848a0d7af9  cloud-artifact.mjs

----- MUTATION: M5 drift protocolVersion 0 -> 99 in both writer and reader -----
$ diff pristine.mjs cloud-artifact.mjs
126c126
<     protocolVersion: '0',
---
>     protocolVersion: '99',
145c145
<     value.protocolVersion !== '0' ||
---
>     value.protocolVersion !== '99' ||
✖ manifest pins journal protocol version zero
ℹ tests 13
ℹ pass 12
ℹ fail 1
restored: 9b2ea8368d6d5adafa4aa936dbd64910ad376e06e6f5faa534230d848a0d7af9  cloud-artifact.mjs

----- MUTATION: M6 remove real execute-mode check -----
✖ verification rejects a required binary whose execute mode was stripped
ℹ tests 13
ℹ pass 12
ℹ fail 1
restored: 9b2ea8368d6d5adafa4aa936dbd64910ad376e06e6f5faa534230d848a0d7af9  cloud-artifact.mjs
```

Restore is byte-identical to the reviewed file, and the pristine copy still passes:

```
$ shasum -a 256 cloud-artifact.mjs /Users/khaliqgant/.../scripts/cloud-artifact.mjs
9b2ea8368d6d5adafa4aa936dbd64910ad376e06e6f5faa534230d848a0d7af9  cloud-artifact.mjs
9b2ea8368d6d5adafa4aa936dbd64910ad376e06e6f5faa534230d848a0d7af9  /Users/khaliqgant/.../scripts/cloud-artifact.mjs

$ node --test cloud-artifact.test.mjs
ℹ tests 13
ℹ pass 13
ℹ fail 0
```

The path-traversal rejection — the block I called out last round as the most security-sensitive
code in the change with zero coverage — is now pinned by two tests. F2 closed.

### F3 — `executable` tautology — **REPAIRED**

Both sides now read the real inode mode: `createManifest` at `:134` and `verifyArtifactDirectory`
at `:109-112`. The prior round's experiment, re-run verbatim against the new code, now inverts:

```
$ node experiments.mjs   # E1
=== E1 (F3) real execute mode ===
manifest executable flags: [["bin/flows",true],["bin/relayflowd",true]]
mode bin/relayflowd after extract: 755
mode bin/relayflowd after chmod 644: 644
verifyArtifactDirectory RESULT: REJECTED -> executable mode mismatch for bin/relayflowd
```

Last round this line read `PASSED with non-executable binaries`. F3 closed.

### F4 — unstated trust boundary — **REPAIRED (as documentation, which is what was asked)**

The threat model is now stated in the code at `scripts/cloud-artifact.mjs:69-71`:

```js
// expectedSha256 is a trust input supplied independently by the artifact
// publisher. This detects corruption or substitution relative to that trusted
// digest; it does not authenticate an archive and its sibling checksum file.
```

and in the PR body, verbatim:

> Threat boundary: the manifest and sibling checksum do not authenticate each other. verify
> accepts the expected SHA-256 as a trust input; it proves integrity only relative to that
> independently published digest. Artifact signing and Cloud consumption are separate
> integration work and are not claimed here.

The CI step was also honestly renamed from `Assemble and verify artifact` to
`Assemble artifact and smoke verifier path` (`:54`), which stops it from reading as integrity
evidence when it is a code-path smoke.

The underlying property is unchanged, and the stated boundary describes it accurately:

```
=== E7 (F4) forged archive + re-stamped manifest ===
forged archive verify RESULT: PASSED (manifest is self-authenticating)
sourceCommit still claims: ffffffffffffffffffffffffffffffffffffffff
```

That is now a documented limitation rather than an implied guarantee. F4 closed as scoped —
this was explicitly "state which threat it covers", not "ship signing", and it did.

---

## Part 2 — new blocking finding

### G1 — **HIGH, BLOCKING** — the shipped `bin/flows` is a silent no-op

The F7 repair swapped the build from a bundle-plus-`node`-shim to a standalone binary
(`.github/workflows/cloud-runtime-artifact.yml:45-52`):

```yaml
bun build sdk/src/cli.ts \
  --compile \
  --target=bun-linux-x64 \
  --outfile=dist/cloud-artifact-input/flows
```

That removes the undeclared Node dependency, which was the right instinct. But the CLI's entry
guard does not survive `--compile`, so `runCli` is never reached. `sdk/src/cli.ts:213-226`:

```ts
function isDirectInvocation(entryPath: string | undefined): boolean {
  if (entryPath === undefined) return false;
  try {
    return pathToFileURL(realpathSync(entryPath)).href === import.meta.url;
  } catch {
    return false;
  }
}

if (isDirectInvocation(process.argv[1])) {
  void runCli(process.argv.slice(2)).then((exitCode) => {
    process.exitCode = exitCode;
  });
}
```

Under `bun --compile` the entry path is a virtual `/$bunfs/` path that `realpathSync` cannot
stat, so the `catch` swallows it and the guard returns `false`. Minimal reproduction, bun 1.4.0
— the same version CI pins at `:32-34`:

```
$ bun build probe.ts --compile --outfile=probe && ./probe
argv[1]=/$bunfs/root/probe
realpathSync THREW: ENOENT: no such file or directory, lstat '/$bunfs/root/probe'
import.meta.url = file:///$bunfs/root/probe
```

Confirmed against the **real** CLI, compiled exactly as the workflow compiles it (in a `/tmp`
copy of `sdk/`, so the repo tree was untouched):

```
$ bun build src/cli.ts --compile --outfile=/tmp/pr131-bun/flows
  [27ms]  bundle  85 modules
 [235ms] compile  /tmp/pr131-bun/flows

$ /tmp/pr131-bun/flows check --json testdata/hello-deterministic.flow.yaml
exit=0 stdout_bytes=0

$ /tmp/pr131-bun/flows --help
exit=0
```

Zero bytes of output. And it fails **open** — it returns success for inputs it is required to
refuse:

```
=== nonexistent flow: node-target build (correct behavior) ===
REFUSED [input_unreadable] Flow ".../testdata/does-not-exist.flow.yaml" is not readable.
{"ok":false,"path":"testdata/does-not-exist.flow.yaml","diagnostics":[{"severity":"refusal","kind":"input_unreadable",...}]}
real exit=2

=== nonexistent flow: --compile standalone (shipped artifact) ===
real exit=0

=== garbage subcommand: --compile standalone ===
real exit=0
```

The regression is isolated to `--compile`. The pre-fix build shape still works:

```
$ bun build src/cli.ts --target=node --outfile=/tmp/pr131-bun/flows-cli.mjs
$ node /tmp/pr131-bun/flows-cli.mjs check --json testdata/hello-deterministic.flow.yaml
WARNING [unprovable_effects] Step "greet" command "echo" resolves, but its effects cannot be proven before execution.
WARNING [unprovable_effects] Step "shout" command "echo" resolves, but its effects cannot be proven before execution.
{"ok":true,"path":"testdata/hello-deterministic.flow.yaml",...,"diagnostics":[...]}
exit=0
```

**This already happened in CI on this head, and CI reported success.** The smoke step ran
`flows check` and it printed nothing:

```
$ gh run view 33631974128 --log | awk -F'\t' '$2=="Smoke exact Linux artifact"'
...
dist/cloud-artifact-smoke/bin/relayflowd --help
dist/cloud-artifact-smoke/bin/flows check --json testdata/hello-deterministic.flow.yaml
...
Relayflow durable execution kernel

Usage: relayflowd [OPTIONS] <COMMAND>
...
  -V, --version              Print version
                                        <-- log ends here. no flows output at all.

$ grep -c '"ok"' /tmp/pr131-run.log
0
```

Compare the previous head, where the same step emitted a real result:

```
$ gh run view 33628277801 --log | awk -F'\t' '$2=="Smoke exact Linux artifact"' | grep '^{'
{"ok":true,"path":"testdata/hello-deterministic.flow.yaml","projectConfigPath":"/home/runner/work/flows/flows/testdata/flows.json","resolutions":[],"diagnostics":[{"severity":"warning","kind":"unprovable_effects","stepId":"greet",...},{"severity":"warning","kind":"unprovable_effects","stepId":"shout",...}]}
```

So the headline platform proof got **weaker** across the fix commit while staying green, and the
job step still reports `"conclusion":"success"`:

```
$ gh api repos/AgentWorkforce/flows/actions/jobs/100253372584 --jq '.steps[] | {name,conclusion}'
{"conclusion":"success","name":"Smoke exact Linux artifact"}
```

Why this is blocking under this lens, three ways:

1. **It violates AGENTS.md §4 fail-closed.** The artifact's `flows` entrypoint returns `0` for
   an unreadable flow and for a nonexistent subcommand. A silent success is the worst available
   failure mode — worse than the `node: not found` crash F7 complained about, because that one
   was at least loud.
2. **It is covenant 2 inverted.** "Nothing may fail at minute 27 that was checkable at minute 0."
   Here nothing fails at all; a consumer pipes `bin/flows check` into a gate, gets exit 0 and
   empty stdout, and concludes the flow is fine.
3. **The PR body now overclaims.** It states the job will "execute flows check against the
   canonical deterministic flow." The command executed; the CLI did not. That is precisely the
   evidence-vs-claim gap AGENTS.md's "Evidence is captured, not narrated" section exists to
   stop, and the reason it survived is #4:
4. **The smoke step asserts exit status only.** `bash -e` catches a crash and nothing else.
   The step cannot distinguish "the CLI works" from "the CLI does nothing", which is why a
   total functional regression shipped green.

Minimum to close: make the smoke step assert on output, not just exit status (e.g. pipe through
`grep -q '"ok":true'`), and fix the entry guard so it holds under `--compile` — `import.meta.main`
is bun's supported signal, or drop the guard in a dedicated CLI entrypoint. The assertion matters
more than the guard fix: without it the next regression of this shape is invisible again.

---

## Part 3 — residual and unaddressed findings

None of these are individually blocking, but G1 should not be fixed without a glance at the first two.

### R1 — **MEDIUM** — `verify` ELF-checks `relayflowd` but not `flows`

`buildCloudArtifact` checks both (`:32-33`), but `verifyArtifactDirectory` checks only
`bin/relayflowd` (`:118`). Now that `flows` is also a native binary, the asymmetry is a real
hole on the verify side — the side that runs against a downloaded tarball:

```
=== E9 verify-side ELF check on bin/flows ===
RESULT: PASSED with a non-ELF bin/flows (verify only ELF-checks bin/relayflowd)
```

The `assertLinuxX64Elf(path, executableName)` signature was already generalized for exactly this;
it just is not called on the verify side.

### R2 — **MEDIUM** — F6 is unaddressed, and the new test adds a third hand-copy

`protocolVersion` is still a literal `'0'` in the writer (`:126`) and the reader (`:145`), and the
new test hardcodes it a third time:

```
$ grep -rn "protocolVersion" scripts/
scripts/cloud-artifact.test.mjs:166:    assert.equal(built.manifest.protocolVersion, '0');
scripts/cloud-artifact.mjs:126:    protocolVersion: '0',
scripts/cloud-artifact.mjs:145:    value.protocolVersion !== '0' ||

$ grep -n "PROTOCOL_VERSION" sdk/src/protocol.ts
15:export const PROTOCOL_VERSION = 0 as const;
```

M5 now dies, so the three copies can no longer drift *from each other* — that is a genuine
improvement. But none of them is connected to `PROTOCOL_VERSION`, so when the SDK bumps to `1`
the artifact still ships `"0"` and all thirteen tests still pass. The test pins a constant to
itself. RFC-0001 §7 leaves journal/spec/SDK versioning explicitly open, which is what makes a
hand-copied version string the thing that ages worst here.

### R3 — **LOW** — F5 downgraded honestly rather than fixed

The build is still not reproducible, but the filename no longer implies it is:

```
=== E5 (F5) two builds, same commit ===
build1 filename : relayflow-v2-eeee...eeee-3e309f520a7bc4eb-linux-x64.tar.gz
build2 filename : relayflow-v2-eeee...eeee-83c50c23a1fc5a71-linux-x64.tar.gz
IDENTICAL SHA256: false
IDENTICAL NAME  : false
manifest1 == manifest2 : true
```

The PR body's claim — "artifact filenames include a content-hash prefix so rebuilds cannot
silently collide" — is exactly true and no larger. That is the smaller-true-claim discipline
AGENTS.md §4 asks for, and I am recording it as correct behavior, not a defect. It does remain
short of RFC-0001 decision 14's content-addressed sealed bundle; the gap is now visible instead
of papered over.

### R4 — **LOW** — build-side `executable` derivation is still unpinned

A mutation reverting `createManifest`'s mode read (`:134`) back to the old tautology
`REQUIRED_EXECUTABLES.includes(path)` survives the suite:

```
----- MUTATION: M7 revert createManifest executable to REQUIRED_EXECUTABLES.includes -----
ℹ tests 13
ℹ pass 13
ℹ fail 0
```

This is close to an equivalent mutant — `buildCloudArtifact` calls `verifyArtifactDirectory`
on the stage at `:48`, so any real divergence between declared and actual mode still fails the
build. Noting it for completeness rather than asking for a test.

### R5 — **LOW** — temp archive leaks on `tar` failure

`:50-54` writes `.relayflow-v2-<commit>-<pid>.tar.gz.tmp` into `outputDir`, but the `finally`
at `:63-65` only removes `stageParent`. A failed `tar` leaves the partial temp file behind.
Harmless to correctness — CI's `find -name '*.tar.gz'` will not match it — but it is litter in
the output directory a stranger has to reason about.

---

## What is good, and should survive the G1 fix

- **The F2 repair is the model.** Seven new tests, each named for the property it defends, each
  killing a specific mutant. `withUnpackedArtifact` is the right seam and made the additions cheap.
- **F3 was fixed at the root, not patched.** Both writer and reader now read the real inode mode,
  so the field means what its name says.
- **F4 was answered honestly** — stated in the code *and* the PR body, and the CI step was renamed
  to stop implying evidence it does not provide. Renaming a step to claim less is unusual and right.
- **The CLI error surface is now entirely in the author's vocabulary**, closing F8's third bullet:
  ```
  === typo in flag name ===      unknown option --flows-executabl for build   exit 1
  === missing required option === missing required option --sha256            exit 1
  === verify with no args ===     missing required option --archive           exit 1
  === unknown command ===         usage: cloud-artifact.mjs build|verify [options]  exit 1
  === duplicate option ===        duplicate option --archive                  exit 1
  === dangling flag ===           invalid arguments                           exit 1
  ```
- **F8's dead clause and self-confirming fixture assert are both gone** (`:182-187`, and the
  removed `assert.equal((await readFile(relayflowd))[0], 0x7f)`).
- **F9 closed** — `testdata/**` is in the path filter (`:12`).
- **Module size is still healthy**: `272` / `238` / `84` lines, well inside AGENTS.md §1.
- **`verifyArtifactDirectory` remains shared by build and verify**, which is why F2 and F3 were
  cheap to fix and why R1 is a two-line change.

---

## Verdict

The prior round's four blocking findings are closed, and I verified each with the same commands
that produced the original complaints. F2 in particular went from five surviving mutants to zero.
That is a real repair, not a narrated one.

The blocker is new. `bin/flows` — half of the artifact this PR exists to produce — does nothing
and reports success while doing it. It shipped green because the smoke step reads exit codes and
the binary always exits `0`, which is the same class of self-confirming check F2 and F4 were about,
relocated into the one step that was supposed to be the platform proof.

A stranger in six months is now worse off than before the fix commit on exactly one axis: they
have a runtime tarball whose `flows` entrypoint silently approves everything, and a green CI badge
saying it was executed against the canonical flow.

Minimum to flip: fix the `--compile` entry guard, and make the smoke step assert on output so that
this failure mode cannot be green again. R1 is worth folding in while the file is open.

REVIEW_FAILED
