# WS-13 review corrections

The original 29 threads and two follow-up threads are tracked individually in [the response ledger](threads.md).
The SDK/code fixes are in `e3f756c`; no kernel or judging gate was changed.

## Corrected gallery: 1 pass, 2 blocked

| Entry | Result | Elapsed | Literal command and output |
|---|---|---:|---|
| dependency-upgrade-bot | **BLOCKED:** `unsupported_header` for `budget`, exit 2 before body execution | 5.138s | [Capture](gallery/gallery-dependency-upgrade-bot.txt) |
| pr-review-pipeline | **BLOCKED:** `unsupported_header` for `budget`, exit 2 before body execution | 3.539s | [Capture](gallery/gallery-pr-review-pipeline.txt) |
| research | **PASS:** three reports and synthesis, exit 0, `completionReason: synthesized` | 690.935s | [Existing default-budget capture](../followup/default-budget/gallery-research.txt) |

The SDK/kernel capability owner must implement the budgets, postfix gates and
workspace semantics of the two blocked examples. They have not been weakened.
Research was not rerun: its unchanged shim's successful authenticated run is
retained. Report copies now remove temporary checkout prefixes from citations;
[the manifest](../followup/default-budget/artifacts.json) records both original
and normalized hashes. Source citations are repository-relative at `ab1e3ff`.

**Correction of a false report:** the old 0.138s/0.143s captures in
`followup/final-sdk/` returned `invalid_invocation` from a stale public launcher.
They were incorrectly reported as budget refusals. The direct packed SDK test
bypassed the launcher and did not validate those invocations. This attempt
installs both candidate SDK and launcher via explicit tarball dependencies in a
new clone. [Install output](install.txt), [all installed files and ESM resolution](installed-identity.txt),
and [pack output with three distinct SDK SHA-256 hashes](pack.txt) establish provenance.
The same 2.0.8 filename represents different candidate revisions, not identical
artifacts. The native daemon is the previously packed published 2.0.8 binary;
no Rust build is claimed here. The first identity helper used CommonJS resolution
for an import-only export and failed; [that helper failure](installed-identity-commonjs-attempt.txt)
is retained. The corrected helper uses the launcher's ESM resolution conditions.

## Verification

| Check | Result | Literal command and captured output |
|---|---|---|
| Build | Exit 0 | [Output](build.txt) |
| SDK/API/existing test-source typechecks | Exit 0 | [Output](typechecks.txt) |
| Observer isolation, wait elapsed, error precedence, lease deadline, Windows refusal and subprocess cancellation | 35 passed | [Output](regressions.txt) |
| Native ARM64 Linux container, focused regressions | 20 passed; no kernel in this selection | [Output](native-container.txt) |
| Built CLI + real macOS daemon | 5 passed, including a 35-second single invocation | [Output](live.txt) |
| Packed launcher + real daemon | Long-lease case selected | [Output](packed-launcher-live.txt) |
| Recorder EOF/whitespace and harness refusal paths | Exit 0 | [Output](helpers.txt), [driver](verify-helpers.py) |

Lease-bound agent/wrapper execution now refuses Windows before spawning: the
shipped macOS/Linux implementation relies on POSIX process groups. The mocked
Windows guard is tested; no native Windows process-tree cancellation is claimed.
The older amd64-emulation esbuild crash and broader kernel-suite timeout remain
failed attempts; this is not a claim that those runs passed or that the full
repository test suite is green. Timing remains accepted by Khaliq: 49.975s for
the cold deterministic loop, 132.637s for the existing-host real Claude command.
No new timing benchmark was run.

## Two follow-up findings

A heartbeat response handled after the prior deadline is now rejected before it
can replace the deadline snapshot. Initial and periodic late-response tests both
leave timer callbacks queued; no expired lease can spawn/complete work. The
recorder now splits only on LF, preserving embedded vertical-tab/form-feed bytes.
[Seven lease tests, recorder checks and SDK build passed](last-two-threads.txt).
The gallery captures above identify the earlier `e3f756c` candidate; these final
lease/recorder changes do not implement either missing gallery budget capability.
No new gallery or cold-timing execution is claimed for this follow-up.

## External handoffs

**Review-swarm / Cloud + Relaycast service owner: INFRA-FAILED.** Per the
user's ruling, this check is infrastructure-owned and is not being repaired in
this lane. At `1aad66a`, preparation and launch passed, then Cloud run
`7202379b-3bcb-4706-b6e3-a7e59495c4e2` failed during Relaycast workspace-key repair
with HTTP 503, database temporarily overloaded. Post-verdict then reported:

> No changes to sync — the workflow did not modify any files.

No fresh maintainability, history or structure transcripts were produced. This
is not a verdict on the PR code and **not independent review signoff**.
[Exact command and captured failure](infra-final.txt),
[job](https://github.com/AgentWorkforce/flows/actions/runs/34274491229/job/102224017363).
The earlier [ACL HTTP 429](cloud-failure.txt) and [ANSI preparation failure](prepare-failure.txt)
remain captured. The latter was fixed in this PR by visibly encoding ESC bytes;
no judging gate was edited. One retry had already been queued before the user
ruled this out of scope; no further manual retries or infrastructure work follow.
The PR carries the current handoff; remain out of draft.

**Release-gate owner:** register and publish `create-flow`; publishing remains
outside this lane. Route both owner assignments through session-thread-rollout.
The PR is out of draft. Do not merge.
