# WS-13 review corrections

The original 29 threads are tracked individually in [the response ledger](threads.md).
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

## External handoffs

**Review-swarm/Cloud relayfile owner:** the failed review job
[34267938676](https://github.com/AgentWorkforce/flows/actions/runs/34267938676)
returned `relayfile ACL GET /.relayfile.acl failed with status 429`, correlation
`499e3981-c303-48e3-89be-595ac66ee3c4`. [Captured failure](cloud-failure.txt).
All three fresh review transcripts are missing; this is **not review signoff**.
The first retry at `14cb174` failed sooner: `gh pr diff` refused two literal
ANSI escape bytes in this newly captured Cloud log. That was an evidence-format
mistake in this PR. The log now encodes ESC as visible `\u001b` text, preserving
the captured content without terminal controls. [Failed preparation](prepare-failure.txt).
The gate is unchanged. See the PR for the retry status at the current head.

**Release-gate owner:** register and publish `create-flow`; publishing remains
outside this lane. Route both owner assignments through session-thread-rollout.
The PR is out of draft. Do not merge.
