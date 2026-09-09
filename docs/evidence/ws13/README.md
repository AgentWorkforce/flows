# WS-13 local development evidence

**Timing is accepted by Khaliq's ruling, not a blocker.** The measured cold
deterministic loop is 49.975s; the existing-host real Claude command is
132.637s. Its agent step is 28.95s including the provider round trip; the
remaining startup/preflight time was not separately measured, so the evidence
does not attribute most of the total to the provider.

**Named handoffs:** the release-gate owner must register `create-flow` in
versioning/packaging/publishing. The review-swarm/CI owner must restore fresh
maintainability, history and structure transcripts; all three are missing and
there is no approving independent signoff. After the PR left draft, Codex
and Cubic produced review findings; the lease-renewal P1 is addressed
in this branch, with [captured verification](followup/README.md). Those findings do not replace the missing swarm transcripts. Neither handoff is a reason to keep
the PR in draft once the gallery results are reported. No publishing work or
Cloud run-publication API is part of this follow-up.

The [current three-entry gallery](../../../examples/README.md) is **1 PASS,
2 BLOCKED** and supersedes the initial invocation results below. Research
completed with the default budget in [690.935s](followup/default-budget/gallery-research.txt);
the SDK flows still refuse unsupported budget headers in the
[corrected, verified launcher runs](review/README.md). The prior 0.138s/0.143s
captures were stale-launcher invocation refusals and had been misclassified. Research now reports each provider probe
and timeout on stderr. [Research regression tests](followup/research-tests.txt)
and [typecheck](followup/research-typecheck.txt) contain the commands/output.

## Initial captured results

| Check | Result | Evidence |
|---|---|---|
| SDK, API type tests, and test-source typechecks | Exit 0 | [Commands and output](typechecks.txt) |
| Clone + empty-cache scaffold + direct deterministic run on fresh Debian Trixie | Completed in 49.975s; Node/Git provisioning excluded; no agent | [Command and output](cold-clone-direct.txt) |
| Earlier clone-inclusive run using npx for the final invocation | Completed in 60.063s; misses the timing target | [Command and output](cold-clone-npx.txt) |
| Focused scaffolding/authored-flow/CLI tests | 121 passed | [Command and output](focused-tests.txt) |
| Built CLI + real daemon + scripted agent wrapper | 4 passed with isolated Node 22.22.2 | [Final command and output](local-agent-tests-final.txt) |
| First live-worker test attempt | 3 process timeouts, 1 passed | [Command and output](local-agent-tests-first-attempt.txt) |
| Real Claude invocation in the generated project | Completed, 132.637s for the command; existing authenticated macOS host | [Transcript](agent-run.txt), [asciicast v2 recording](agent-run.cast) |
| Earlier recording attempts | Auth probe timeout; then a broken host Node shared-library dependency | [Auth timeout](agent-probe-timeout.txt), [host failure](agent-host-node-failure.txt) |
| Empty-cache install + deterministic run in fresh Debian Trixie container | Completed in 43.374s; Node/image provisioning excluded, empty npm cache, deterministic template, no source clone or agent | [Command and output](cold-trixie.txt) |
| Empty-cache install + deterministic run in fresh Debian Bookworm container | Refused: published Linux daemon requires GLIBC_2.39; 55.223s | [Command and output](cold-container.txt) |
| Linux container test runner | esbuild Go runtime crashed under amd64 emulation before collecting tests | [Command, script and full output](container-tests.txt) |
| Research typecheck after correcting its compiler path | Superseded by the complete follow-up capture | [Command and output](followup/research-typecheck.txt) |

The [gallery table](../../../examples/README.md) reports the three requested
entries individually. Unsupported budget headers remain a capability-owner
handoff. The initial research attempt reached an outer 150-second limit with
no captured output; the follow-up now exposes preflight progress and captures
the shim's own failure or success result. No gallery declaration was weakened.

The cold-container transcripts include provisioning output followed by the
inner command’s elapsed value; `record.py` was used for the separate PTY
agent recordings, not to time the cold Docker commands. Node/image/Git
provisioning is excluded from those cold command timings.

The recording uses the initial packed implementation plus the npm bin fix.
Its agent step invokes the real installed Claude CLI. The host already had
Node, provider authentication, and dependencies; this is **not** a cold-machine
measurement. The recorded command does not include a clone or installation.
Text transcripts normalize terminal CRLF to LF and trim trailing whitespace; the `.cast` files retain the
captured terminal bytes and elapsed timestamps.

The functional CLI fixture has a 90-second cleanup ceiling. Its original
30-second process limit terminated a request while the worker still held a
live lease ([captured failure](local-agent-tests-30s-ceiling.txt)); startup and
preflight happen before that lease begins. Kernel lease behavior and the
separate 60-second cold-start criterion were not changed. Test-source types
were [checked again](test-types-final.txt) after fixing fixture binary discovery
to ask the existing Cargo wrapper for this worktree's target directory.

The local worker is stream-only. Each invocation declares a fresh stream at
offset zero and uses the existing `AgentWorker` and journal protocol. It
refuses workspace declarations rather than inventing revision pins. It is a
worker attached to the selected local daemon, not an OS sandbox. The executor
still lowers each authored step to a separate kernel run; whole-body durable
resume is not introduced by this change.

## Candidate artifacts, not a published release

`create-flow` is not published. The new CLI imports the SDK's lightweight
`/create-flow` export; `relayflows` imports `/cli`, so package lookup works with
both nested and hoisted npm dependencies. Runtime packages stop registering
their legacy bundled executable as the competing npm `flows` command.
[The original artifact failure](launcher-before-fix.txt) is retained.

Build and pack from this branch with Node 22.18+:

```sh
npm --prefix packages/sdk ci --ignore-scripts
npm --prefix packages/sdk run build
mkdir -p /tmp/ws13-artifacts
npm pack --ignore-scripts --pack-destination /tmp/ws13-artifacts ./packages/sdk
npm pack --ignore-scripts --pack-destination /tmp/ws13-artifacts ./packages/create-flow
npm pack --ignore-scripts --pack-destination /tmp/ws13-artifacts ./packages/relayflows
```

For full installation testing, stage each runtime package's `bin/` from the
published 2.0.8 package before packing the updated runtime manifest. This
session reused those published binaries; it did not rebuild or change Rust.
The runtime tarballs retain legacy `bin/flows` because the existing release
gate requires it, while their npm `bin` maps now export only `relayflowd`.
The Debian failure above belongs to that published binary's libc requirement.

Serve all candidate tarballs locally:

```sh
node docs/evidence/ws13/stage-registry.mjs /tmp/ws13-artifacts 48734
```

The registry binds to loopback by default. For Docker access, explicitly
add the bind host: `node docs/evidence/ws13/stage-registry.mjs /tmp/ws13-artifacts 48734 0.0.0.0`.

In a separate terminal, point npm at that registry; dependencies outside this
branch redirect to the public npm registry:

```sh
npm_config_registry=http://127.0.0.1:48734 npx --yes create-flow@latest /tmp/my-flow
cd /tmp/my-flow
npm start
```

The final served tarballs match the SHA-256 values in [artifacts.json](artifacts.json).
[Packed-file hash check](artifact-check.txt). Restart the registry after repacking; it freezes package metadata and tarball bytes
at startup. Earlier cold recordings used the SDK-root launcher; the final
clone-inclusive recording uses the lightweight SDK/cli launcher.

`cold-start.sh` uses the same registry with the deterministic template and an
empty cache. `record.py` captures real process output as an asciicast and text
transcript. Neither script silently converts a refusal into a successful run.

## Scope and release blockers

Base: `origin/main` at `f0a3b3b` (2.0.8), isolated branch
`feat/flows-local-dev-ux`. Both #243 and #244 diffs were inspected before SDK
edits. #243 is now merged; #244 remains open. Overlap with #243 is README.md,
`packages/sdk/src/authored-flow-executor.ts`, and `packages/sdk/src/cli/direct-run.ts`.
There is no file overlap with #244's inspected diff. Existing executor error,
output, gate, and lifecycle behavior is reused; its pre-existing size was not
expanded into an unrelated refactor.

The independent release-gate owner must add `create-flow` to package versioning
and publishing, and to `scripts/pack-release.mjs`, which currently refuses that
package name. That script also requires the legacy runtime executable.
Those gates were not edited. No package was published and no merge is allowed. PR #247 is ready for review,
not in draft; publishing and review are named handoffs.

Veto tools were not exposed. Relay queue receipts did not establish delivery;
the coordinator confirmed the original handoff never arrived. The PR and this
evidence directory are the durable handoff.
