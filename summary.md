# Detach local run and resume processes from the invoking terminal

Closing a terminal currently kills `--local-agent` and authored TypeScript flow
bodies. `flows run/resume --detach` moves the whole CLI execution into its own
session, returns the admitted run ID, and provides log/receipt paths and a
`flows status` command. Both agent workers and authored bodies can continue
after the invoking terminal closes.

- Preflight runs once in the child. Atomic receipts return startup refusals
  with their original diagnostics and exit code; replayed resume history is
  never treated as admission.
- Observer URLs use an explicit callback and a bounded wait. Late URLs and
  terminal outcomes remain in the receipt/log. Cloud mirroring stays opt-in.
- Local worker remedies explain terminal lifetime and `--detach`. Help and
  `docs/SURFACE.md` describe exit semantics, credentials, logs, and inspection.
- Startup is bounded and reports early child failure with a log tail.
  `FLOWS_LOCAL_AGENT_ENV_FD` is refused rather than silently dropped.

Scope: implements **rung 1** of `reviewed-plan.md` §7, its explicitly recommended
standalone release. `worker.release`, `flows worker start/stop/list`, and
redrive-on-attach remain follow-ups. No kernel behavior or workflow files change.
This is process detachment, not automatic restart supervision. The parent's
exit 0 confirms admission; the child may subsequently fail, park, or suspend.

Validation: 244 tests passed across nine selected suites, including real-kernel
YAML, authored-body, and resume cases that kill the invoking terminal's process
group mid-agent, then assert completion through `flows status --json`.
The tests also cover preflight refusal, human-influenced resume consent,
park receipts/remedies, timeout/early-exit handling, observer publication,
argument forwarding, and the CLI declaration. Provider execution uses a
controlled wrapper fixture, not paid provider calls.

Literal commands and complete captured output:

- [Regression suites, including LIVE_KERNEL paths, parent exit, group kill, and subsequent status output](evidence/detached-runs/regressions.txt)
- [SDK build](evidence/detached-runs/sdk-build.txt)
- [SDK and public type checks](evidence/detached-runs/typecheck.txt)
- [Test type check](evidence/detached-runs/test-typecheck.txt)
- [Kernel binary build used by live tests](evidence/detached-runs/kernel-build.txt)

The full SDK suite and kernel test suite were not run. No mutation-verification
claim is made. Live-test temporary directories are removed by fixture cleanup;
the captured outputs above are retained.
