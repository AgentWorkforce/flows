# WS-13 follow-up: final gallery and lease correction

PR #247 is out of draft. Timing is accepted by Khaliq's ruling. The existing
49.975s deterministic and 132.637s real-agent command transcripts remain in the
parent directory; no further timing experiment was completed after that ruling.

The three requested gallery entries have individual, explicit outcomes:

| Entry | Result | Elapsed | Command and output |
|---|---|---:|---|
| dependency-upgrade-bot | BLOCKED: `unsupported_header` for `budget`, exit 2 before the body | 0.138s | [Final SDK capture](final-sdk/gallery-dependency-upgrade-bot.txt) |
| pr-review-pipeline | BLOCKED: `unsupported_header` for `budget`, exit 2 before the body | 0.143s | [Final SDK capture](final-sdk/gallery-pr-review-pipeline.txt) |
| research | PASS: three lane reports and synthesis, `completionReason: synthesized`, exit 0 | 690.935s | [Default-budget capture](default-budget/gallery-research.txt) |

The SDK/kernel capability owner must supply the two blocked flows' budget
headers, postfix artifact gates and declared workspace behavior. Those
requirements were not removed or weakened. Research uses its documented source
shim; the SDK examples use installed candidate npm artifacts. These are runs
on an authenticated development host in a separate clone, not cold benchmarks.
The final SDK artifact's [hash](final-sdk/artifact.json) identifies the package
used for the last two invocations; it includes the lease fix below. Research's
shim does not import AgentWorker and was unchanged by that fix.

Research now prints each preflight probe and its timeout on stderr, leaving
stdout for the structured result. The first follow-up used a shorter three-minute
step bound and failed ([217.375s transcript](gallery-research.txt)). The retry
used the documented default 30-minute per-step budget and completed. Generated
[reports](default-budget/reports/) and [artifact hashes](default-budget/artifacts.json)
are retained as execution evidence; they are model-generated research output.

After ready-for-review triggered Codex/Cubic comments, a P1 exposed that the
existing worker did not renew its 30-second lease. AgentWorker now renews
through `step.heartbeat`, confirms ownership before starting the CLI, and stops
the process group if renewal fails or its response does not arrive before lease
expiry. It drains outstanding renewals before `step.complete`. Renewal failures
never produce successful completions. There is no kernel protocol or gate change.
Existing fake worker clients gained the protocol heartbeat/deadline fields;
their assertions were preserved.

| Verification | Result | Literal command and captured output |
|---|---|---|
| Research regression suite | 27 passed | [Transcript](research-tests.txt) |
| Research typecheck | Exit 0 | [Transcript](research-typecheck.txt) |
| Worker lease and existing wrapper suite | 17 passed | [Transcript](heartbeat-tests.txt) |
| Real raw/wrapper subprocess cancellation | 2 passed | [Transcript](heartbeat-abort.txt) |
| Built CLI + real daemon | 5 passed, including a 35s single-invocation case | [Transcript](heartbeat-live.txt) |
| Packed SDK + real daemon, same long case | 1 selected test passed; 4 not selected | [Transcript](heartbeat-packed.txt) |
| SDK/API/test-source types | Exit 0 | [Transcript](sdk-typechecks.txt) |
| Broader live-kernel suite | 29 passed, 1 hit its unchanged 5s timeout | [Failure retained](kernel-suite.txt) |
| Isolated rerun of that unchanged case | Passed; 29 other cases not selected | [Transcript](kernel-case-retry.txt) |

No full-suite green or mutation verification is claimed. No package was
published. The release-gate owner must register `create-flow` for packaging and
publishing. The review-swarm/CI owner must obtain fresh maintainability, history
and structure transcripts; the old missing transcripts and new review comments
are not approving signoff at the final head. Lower-priority review comments
remain for review; this report does not claim every comment is resolved.

`run-gallery.py` takes a clone and a fresh evidence directory. Use
`research-default` for the documented-budget research run or `sdk-only` for the
two SDK examples. It resolves Node from PATH and refuses to overwrite captures.
Earlier invocations used `/tmp/ws13-toolchain` to select the isolated Node 22
installation; the captured argv retains those actual paths.
