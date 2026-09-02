# PR #131 — maintainability review

- **Reviewer lens:** maintainability — *could a stranger safely understand and change this in six months?*
- **PR:** https://github.com/AgentWorkforce/flows/pull/131 — "feat(release): build verified Cloud v2 runtime artifact"
- **Exact head reviewed:** `46ce1623e99f43d06a692cb49d657ef602c1b096`
- **Base:** `main` @ `51415d9c65ef5c727c560c700f63932893a1e224`
- **Date:** 2026-09-02
- **Constitution read in full:** `AGENTS.md`, `docs/RFC-0001-everything-is-a-relayflow.md`
- **Mode:** assessment only. No product code was modified. All mutation experiments were
  run against **copies** in `/tmp/pr131-mut/`; the repo working tree was never edited.

---

## 0. Scope confirmation

```
$ git rev-parse HEAD
46ce1623e99f43d06a692cb49d657ef602c1b096

$ gh pr view 131 --json number,headRefOid,baseRefName,state
{"baseRefName":"main","headRefOid":"46ce1623e99f43d06a692cb49d657ef602c1b096","number":131,"state":"OPEN"}

$ git diff --stat 51415d9 46ce1623e99f43d06a692cb49d657ef602c1b096
 .github/workflows/cloud-runtime-artifact.yml |  77 +++++++++
 scripts/cloud-artifact.mjs                   | 249 +++++++++++++++++++++++++++
 scripts/cloud-artifact.test.mjs              |  86 +++++++++
 3 files changed, 412 insertions(+)
```

Three added files, no deletions, no modifications. All three were read in full.

Baseline — the suite passes as shipped:

```
$ node --test scripts/cloud-artifact.test.mjs
✔ builds and verifies the exact Linux x64 Cloud artifact contract (95.68475ms)
✔ verification fails after a manifested runtime file is tampered (74.103791ms)
✔ outer checksum mismatch fails before extraction (44.475416ms)
ℹ tests 3
ℹ suites 0
ℹ pass 3
ℹ fail 0
```

The PR's central platform claim is **real and reproduces**. CI ran on Ubuntu and the
smoke step executed the artifact's own binaries:

```
$ gh pr checks 131
CodeRabbit	pass	0		Review rate limited
linux-x64-artifact	pass	3m2s	https://github.com/AgentWorkforce/flows/actions/runs/33628277801/job/100241146729

$ gh run view 33628277801 --log   # "Smoke exact Linux artifact" step, output lines
Relayflow durable execution kernel

Usage: relayflowd [OPTIONS] <COMMAND>

Commands:
  run     Start and execute a run spec JSON file
  resume  Resume a run from its durable journal
  serve   Serve journal protocol v0 over a Unix socket
  help    Print this message or the help of the given subcommand(s)
...
{"ok":true,"path":"testdata/hello-deterministic.flow.yaml","projectConfigPath":"/home/runner/work/flows/flows/testdata/flows.json","resolutions":[],"diagnostics":[{"severity":"warning","kind":"unprovable_effects","stepId":"greet",...}]}
```

I want that stated plainly before the findings: the Linux build/run proof is not
narrated, it happened. The problems below are about the *contract around* that proof,
not about whether the binary runs.

(Sidebar, not a finding against this PR: `CodeRabbit pass — "Review rate limited"` is
verbatim the failure class RFC-0001 §2 rule 7 was written about. A green vendor check
here is measuring quota, not quality.)

---

## Findings

### F1 — **HIGH** — the provenance field records a commit that does not exist

`sourceCommit` is the manifest's whole reason for existing: it is how a stranger in six
months answers "which source produced this binary". In the only real execution of this
workflow, it recorded an **ephemeral GitHub merge ref**, not the PR head.

From the CI log of the passing run (`Assemble and verify artifact` step):

```
{"archivePath":".../relayflow-v2-41a778318219979d83e625e0831935eed3d811c8-linux-x64.tar.gz",
 "manifest":{"schemaVersion":1,"protocolVersion":"0",
 "sourceCommit":"41a778318219979d83e625e0831935eed3d811c8","platform":"linux","arch":"x64",...}}
```

That SHA is not the PR head, and it is not reachable from any branch:

```
$ git cat-file -t 41a778318219979d83e625e0831935eed3d811c8
fatal: git cat-file: could not get object info

$ git fetch origin refs/pull/131/merge && git log --format='%H %p %s' -1 FETCH_HEAD
41a778318219979d83e625e0831935eed3d811c8 51415d9 46ce162 Merge 46ce1623e99f43d06a692cb49d657ef602c1b096 into 51415d9c65ef5c727c560c700f63932893a1e224
```

Cause: `.github/workflows/cloud-runtime-artifact.yml:50` runs `source_commit="$(git rev-parse HEAD)"`,
and for `pull_request` events `actions/checkout` checks out the merge ref. The workflow
also fires on `workflow_dispatch` (line 4), where `HEAD` *is* the branch tip. So the
semantics of `sourceCommit` silently depend on which trigger fired, and nothing in the
code, the manifest, or the PR body says so.

Six-months consequence: someone holding a tarball tries `git checkout <sourceCommit>`,
gets `unknown revision` (GitHub GCs closed-PR merge refs), and cannot tell whether the
artifact is untrustworthy or the tooling is. This is the exact provenance property
RFC-0001 settled decision 14 asks for — *"every journal records exactly which flow
version produced it (provenance)"* — and it is currently wrong under the trigger that
actually ran. `github.event.pull_request.head.sha` (with `github.sha` fallback) is the
fix; the validator can't catch it because a merge SHA is a perfectly well-formed 40-hex.

### F2 — **HIGH** — four of the six advertised fail-closed guarantees are pinned by no test

The PR body advertises the contract as six bullets. I mutation-tested each guard by
copying the module and its suite to `/tmp/pr131-mut/`, deleting one guard at a time,
running the suite, and restoring from a pristine copy (hash-verified each round).

```
$ cd /tmp/pr131-mut && cp cloud-artifact.mjs pristine.mjs && shasum -a 256 pristine.mjs
4b5cde02c711a6a16e364fc0b713debc01f9c2407e60457b315cf26f7aaf218b  pristine.mjs
```

Results — **five of five mutations survived**:

```
----- MUTATION: M1 remove archive-contents-must-match-manifest check -----
✔ builds and verifies the exact Linux x64 Cloud artifact contract (99.71325ms)
✔ verification fails after a manifested runtime file is tampered (81.076417ms)
✔ outer checksum mismatch fails before extraction (49.389708ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
restored: 4b5cde02c711a6a16e364fc0b713debc01f9c2407e60457b315cf26f7aaf218b  cloud-artifact.mjs
----- MUTATION: M2 remove manifest path-traversal rejection -----
✔ builds and verifies the exact Linux x64 Cloud artifact contract (92.042375ms)
✔ verification fails after a manifested runtime file is tampered (76.399667ms)
✔ outer checksum mismatch fails before extraction (44.177125ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
restored: 4b5cde02c711a6a16e364fc0b713debc01f9c2407e60457b315cf26f7aaf218b  cloud-artifact.mjs
----- MUTATION: M3 remove ELF platform guard from verifyArtifactDirectory -----
✔ builds and verifies the exact Linux x64 Cloud artifact contract (86.918417ms)
✔ verification fails after a manifested runtime file is tampered (76.826209ms)
✔ outer checksum mismatch fails before extraction (46.488333ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
restored: 4b5cde02c711a6a16e364fc0b713debc01f9c2407e60457b315cf26f7aaf218b  cloud-artifact.mjs
----- MUTATION: M4 remove required-executables check -----
✔ builds and verifies the exact Linux x64 Cloud artifact contract (94.319584ms)
✔ verification fails after a manifested runtime file is tampered (78.476917ms)
✔ outer checksum mismatch fails before extraction (45.542708ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
restored: 4b5cde02c711a6a16e364fc0b713debc01f9c2407e60457b315cf26f7aaf218b  cloud-artifact.mjs
----- MUTATION: M5 drift protocolVersion 0 -> 99 in both writer and reader -----
✔ builds and verifies the exact Linux x64 Cloud artifact contract (87.876125ms)
✔ verification fails after a manifested runtime file is tampered (70.381ms)
✔ outer checksum mismatch fails before extraction (47.184875ms)
ℹ tests 3
ℹ pass 3
ℹ fail 0
restored: 4b5cde02c711a6a16e364fc0b713debc01f9c2407e60457b315cf26f7aaf218b  cloud-artifact.mjs
```

Mapping to the PR body's own bullets:

| PR body claim | Code | Pinned by a test? |
|---|---|---|
| source commit / protocol / platform / arch explicit | `parseManifest` 130–142 | **no** (M5) |
| assembly rejects non-ELF64 x86-64 relayflowd | `assertLinuxX64Elf` 179–193 | build side: manual only. verify side: **no** (M3) |
| manifest contents must exactly match archive files | 93–95 | **no** (M1) |
| every file digest is checked | 96–103 | **yes** — test 2 |
| both required executables declared executable | 104–107 | **no** (M4) |
| tampering + outer-checksum mismatch regression-tested | — | **yes** — tests 2 and 3 |

The most security-sensitive block in the change — `parseManifest`'s absolute-path and
`..` rejection (lines 148–149), which is what stops a hostile manifest from steering
digest checks outside the extraction root — is the one with **zero** coverage. A stranger
deleting those two lines during a cleanup gets a green suite and a green CI job.

This is the concrete AGENTS.md §5 gap ("tests pin deterministic code") and it is what
makes the module unsafe to change in six months: the file *looks* rigorously guarded, so
a future editor will trust the tests to catch them, and the tests will not.

### F3 — **HIGH** — `executable: true` is a tautology, and the real mode is never verified

`createManifest` computes the field from a constant (line 124):

```js
executable: REQUIRED_EXECUTABLES.includes(path),
```

and `verifyArtifactDirectory` then checks the manifest against **the same constant**
(lines 104–107). For any manifest this code produced, the check cannot fail. It is a
mirror, not a gate — which is why M4 above survived.

Worse, nothing anywhere verifies the mode on disk. I built an artifact, extracted it,
stripped the execute bit from **both** required binaries, and verification still passed:

```
$ node e1.mjs <fixture>
mode bin/relayflowd after extract: 755
mode bin/relayflowd after chmod 644: 644
verifyArtifactDirectory RESULT: PASSED with non-executable binaries
manifest executable flags: [["bin/flows",true],["bin/relayflowd",true],["lib/flows-cli.mjs",false]]
manifest keys: ["schemaVersion","protocolVersion","sourceCommit","platform","arch","files"]
```

The PR body's wording ("must be **declared** executable") is technically defensible, but
the field name in a shipped manifest is an implicit contract, and it reads to any
stranger as "verified executable". The failure it would catch — an unarchiver, a
container COPY, or an artifact round-trip dropping the mode bit, which is a common and
real way a runtime tarball arrives broken — is precisely the failure it does not catch.
Either verify `stat().mode & 0o111` against the flag, or delete the field.

### F4 — **MEDIUM/HIGH** — the trust boundary is never stated, and the manifest is self-authenticating

The PR body says "the artifact contract is fail-closed" and "tampering ... regression-tested".
Under the corruption reading that is true. Under the tamper reading it is an overclaim,
because `manifest.json` is excluded from its own digest list (line 90) and nothing signs
it. An attacker who can rewrite the archive simply re-stamps the manifest:

```
$ node e7.mjs <fixture>
forged archive verify RESULT: PASSED
sourceCommit still claims: ffffffffffffffffffffffffffffffffffffffff
payload now: console.log("ATTACKER PAYLOAD");
```

The manifest therefore adds no integrity beyond the outer sha256, and the outer sha256 is
only meaningful if it arrives over a channel independent of the archive. That channel does
not exist here — the checksum is a sibling file written by the same function (line 58),
and CI reads it straight back out of that file:

```yaml
# .github/workflows/cloud-runtime-artifact.yml:56-60
archive="$(find dist/cloud-artifact -name '*.tar.gz' -type f -print -quit)"
checksum="$(awk '{print $1}' "$archive.sha256")"
node scripts/cloud-artifact.mjs verify \
  --archive "$archive" \
  --sha256 "$checksum"
```

So the CI "verify" step compares a hash of the archive against a hash computed from that
same archive seconds earlier. It cannot fail, and it therefore proves nothing — a second
instance of the F2 pattern, this time in the workflow rather than the suite. It is still
useful as a smoke of the *verify code path*; it is not evidence of integrity, and the PR
body presents the fail-closed bullet list as though it were.

Relatedly, `verifyCloudArtifact` extracts with `tar -xzf` (line 79) *before* any entry
path is validated. That ordering is safe only under "the checksum came from somewhere I
trust". Nothing in the module says that, so a future maintainer pointing `verify` at a
downloaded bucket object — the literal intended use — inherits an unstated assumption.

RFC-0001 decision 14 anticipates the missing piece ("a signature from its identity").
I am not asking this PR to ship signing; I am asking it to *state which threat it covers*,
because right now the code and the PR body imply a stronger property than the code has.

### F5 — **MEDIUM** — the archive is not reproducible, but its filename claims it is

The filename is `relayflow-v2-<sourceCommit>-linux-x64.tar.gz` (line 53) — a name that
promises the commit determines the contents. It does not. Two builds from identical
inputs and an identical commit produce identical manifests and different archives:

```
$ node e5.mjs <fixture>
build1 filename : relayflow-v2-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-linux-x64.tar.gz
build2 filename : relayflow-v2-eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee-linux-x64.tar.gz
build1 sha256   : 4fd07ece3996770bf0c8aa2d8627d9ca34f92da118724c1506c654e62421cf63
build2 sha256   : e1b8533c4e05168a1f4db587cee992cc6de8e4b23dcdc31f077b7ee6a17c9b3c
IDENTICAL SHA256: false
manifest1 == manifest2 : true
```

`tar -czf` (line 55) stamps per-file mtimes into the headers, so the digest floats with
wall-clock time. Two CI re-runs of the same commit yield two different artifacts under
**one filename** — a name collision in any bucket keyed by that name, and no way for a
consumer to confirm "the artifact I have is the artifact that commit produces".

This is the gap between what this PR builds and RFC-0001 decision 14's content-addressed
sealed bundle. Cheap fix if desired (`--sort=name --mtime=@0 --owner=0 --group=0
--numeric-owner` plus `gzip -n`); the maintainability ask is smaller — either make it
reproducible or stop implying reproducibility in the filename.

### F6 — **MEDIUM** — `protocolVersion` is a hand-copied string that cannot drift-detect

The manifest declares `protocolVersion: '0'` in the writer (line 117) and re-asserts
`'0'` in the reader (line 136). The real protocol version lives elsewhere, as a number:

```
$ cat sdk/src/protocol.ts
// Journal protocol v0 — the SDK boundary (kernel DESIGN.md §5).
...
/** Stamped per segment; readers read every past version, writers write newest. */
export const PROTOCOL_VERSION = 0 as const;
```

Nothing connects the two. When the SDK bumps to protocol 1, this artifact keeps shipping
`"0"` and every check still passes (M5 above shows the suite is indifferent to the value
entirely). A stranger asked "which protocol does this artifact speak?" gets an answer the
build has no way to have gotten wrong *or* right. Given RFC-0001 §7 keeps journal / spec /
SDK-protocol versioning explicitly open, a hardcoded stringified copy of one of the three
is the version of this that ages worst. Import `PROTOCOL_VERSION` (and reconcile
number-vs-string) so a bump breaks the build instead of shipping a lie.

### F7 — **MEDIUM** — the artifact silently requires an undeclared `node` on the host

The `flows` entrypoint is a shell shim written at line 43:

```js
'#!/bin/sh\nexec node "$(dirname "$0")/../lib/flows-cli.mjs" "$@"\n',
```

That is the only mention of `node` in the delivered artifact:

```
$ grep -rn "node" scripts/cloud-artifact.mjs
scripts/cloud-artifact.mjs:1:#!/usr/bin/env node
scripts/cloud-artifact.mjs:3:import { spawnSync } from 'node:child_process';
...
scripts/cloud-artifact.mjs:43:      '#!/bin/sh\nexec node "$(dirname "$0")/../lib/flows-cli.mjs" "$@"\n',
```

The manifest has no runtime-requirements field (`manifest keys: ["schemaVersion",
"protocolVersion","sourceCommit","platform","arch","files"]`, per F3's output). So an
artifact named "the Cloud v2 runtime" is half a static binary and half a Node script with
an unpinned, undeclared interpreter dependency. CI never surfaces this because
`actions/setup-node@v4` put Node 22 on PATH (workflow lines 23–25) long before the smoke
step ran, and `bun build --target=node` (line 44) does not record a floor either.

This is covenant 2's exact shape — *"nothing may fail at minute 27 that was checkable at
minute 0"*. Deployed to a minimal container, `bin/flows` dies with `node: not found`,
which is an undeclared failure, not a typed one. Declaring `requires: {node: ">=22"}` in
the manifest and checking it in `verify` would make it provable at minute 0.

(Minor, same shim: `$(dirname "$0")` does not resolve symlinks, so symlinking `bin/flows`
onto `PATH` — the obvious install gesture — breaks it.)

### F8 — **LOW** — small dead/self-confirming code that misleads a reader

- `assertRegularFile` (lines 172–177) tests `!stat.isFile() || stat.isSymbolicLink()`.
  After `lstat`, the second clause is unreachable — a symlink already fails `isFile()`:

  ```
  lstat(symlink).isFile() = false
  lstat(symlink).isSymbolicLink() = true
  => second clause of assertRegularFile is unreachable: true
  ```

  Harmless, but it advertises a symlink defense that actually lives in `listFiles`
  (line 167). A reader hardening this later will patch the wrong function. AGENTS.md §6.

- `cloud-artifact.test.mjs:84` asserts `(await readFile(relayflowd))[0] === 0x7f` on a
  buffer the same helper wrote four lines earlier. It tests the fixture, not the code.

- CLI errors leak Node internals instead of naming the author's mistake — an unknown flag
  is silently swallowed by `parseArgs` (lines 212–222) and surfaces as a `resolve(undefined)`
  TypeError:

  ```
  === typo in flag name ===
  The "paths[0]" argument must be of type string. Received undefined
  exit 1
  === missing source-commit ===
  source commit must be a full lowercase git SHA
  exit 1
  === unknown command ===
  usage: cloud-artifact.mjs build|verify [options]
  exit 1
  === verify with no args ===
  The "paths[0]" argument must be of type string. Received undefined
  exit 1
  ```

  Two of four paths give the author's-vocabulary message covenant 1 requires; two give
  engine internals. Rejecting unknown flag names and requiring the four options up front
  closes it.

### F9 — **LOW** — the CI path filter omits an input the job depends on

The `pull_request` trigger (workflow lines 5–11) fires on `kernel/**`, `sdk/**`, and the
two scripts. The smoke step depends on `testdata/hello-deterministic.flow.yaml`
(line 68), which is not in the filter. Editing that fixture cannot break this job on its
own PR; it breaks on the next unrelated `sdk/**` change, pointing the blame at the wrong
author. Add `testdata/**` or pin the smoke input inside the job.

---

## What is good, and should survive any rework

Recording this because a review that only lists defects mis-teaches the next author.

- **Module size and seams.** 249 lines, well under the AGENTS.md 500-line smell threshold,
  partitioned into single-purpose functions with no function doing two jobs.
- **`verifyArtifactDirectory` is shared by build and verify** (called at line 51 and
  line 80). The artifact is checked with the same code path that will check it later —
  the right structural decision, and the reason the fixes above are cheap.
- **`listFiles` throws on any non-regular entry** (line 167) rather than skipping it.
  That is genuine fail-closed instinct in the place it matters most.
- **Test 2 is a real test.** It tampers a file after packing and asserts the digest
  mismatch by message — it fails if the hashing breaks. It is the template the other
  guards need.
- **The negative platform proof in the PR body is honest** and reproduces: the macOS
  `relayflowd` is rejected by `assertLinuxX64Elf` with a captured non-zero exit.
- **The PR body scopes itself accurately** — "Cloud consumption is a separate integration
  proof and is not claimed by this PR" is the smaller-true-claim discipline AGENTS.md §4
  asks for, and it is respected.

---

## Verdict

The code is clean, small, and well-seamed; the Linux build-and-run proof is real. The
failure is in the *contract*, which is the whole subject of the maintainability lens.

A stranger in six months meets a module that presents itself as a rigorous fail-closed
artifact gate, and four of its six advertised guarantees — including the only path-safety
check — are held up by nothing. They will trust the green suite, delete or weaken a guard,
and ship it. Meanwhile the field that answers "where did this binary come from" currently
records a garbage-collected merge ref (F1), the field that answers "is it runnable"
is a mirror of a constant (F3), and the filename promises a reproducibility the build does
not have (F5).

F1, F2, and F3 are individually blocking under the six-month-stranger standard. F4's
overclaim is fixable with a paragraph rather than code, but should not ship unstated.

Suggested minimum to flip this: correct `sourceCommit` to the PR head SHA; add tests that
kill mutations M1–M4 (extra archived file, missing archived file, `..`/absolute manifest
path, non-ELF `bin/relayflowd`, stripped exec bit); verify real file modes or drop the
`executable` field; state the threat model `verify` covers.

REVIEW_FAILED
