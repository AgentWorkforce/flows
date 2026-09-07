# Spec review 2026-09-07: not approved for merge

Four focused regression tests failed before the repair and passed after it.
These are before/after regressions, not a full mutation-verification claim.
- [Before](spec-review-regressions-before.txt)
- [After](spec-review-regressions-after.txt)

The full workspace run initially failed in doctests because ambient rustdoc
used a different compiler from the explicitly selected rustc. The failure is
preserved in [first run](spec-review-kernel-tests.txt). Selecting matching
RUSTC and RUSTDOC produced the [final workspace output](spec-review-kernel-tests-final.txt),
including crash/resume tests and doctests. [SDK output](spec-review-sdk-tests.txt)
covers placement, parity and verb-field lint. Each file contains its literal
command, complete captured output, and exit code.

Repairs tighten admission/replay without adding further vocabulary:
- Attempt-scoped routes now fail replay with the same diagnostic as append.
- Epoch routing is validated transactionally, including preservation of prior
  routes; a raw summary cannot silently drop or replace a routing decision.
- Worktree pins peel HEAD to a commit and refuse non-commit objects.

Unresolved blockers:
1. RFC-0001 decision #13 / the assigned vocabulary rule: `step.routed`,
   `epoch.summary.routing`, `StepDispatch.routing`, and the exact kernel
   `requirements` schema have no explicit specification in RFC-0001. Gate 7
   requires routing evidence but does not settle this extension's schema.
   Khaliq/spec owner must settle the contract or require lowering to existing
   facts. This repair does not amend the RFC or approve the vocabulary.
2. `engine/placement.rs:163` still re-reads HEAD at every deterministic attempt.
   [Reproduction](spec-review-source-drift-repro.txt) shows a source commit
   changed between steps and resume completing against different source pins.
   The [repro script](spec-review-source-drift-repro.py) takes the built daemon
   path. Pin storage/recovery needs a design consistent with the settled
   vocabulary; this patch does not invent another durable field to conceal it.

The existing descriptor and blank routing-field findings were already fixed
at the reviewed head. Neither local passing tests nor vendor checks supply
independent review or override the specification blockers.
