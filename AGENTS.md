# Standards for every agent working in this repo

You are building the base a company stands on, presented at YC on 2026-09-15.
The constitution is `docs/RFC-0001-everything-is-a-relayflow.md`. Read it before
writing code. If your work contradicts it, your work is wrong.

## Code standards — clean and tight, enforced

1. **Small, single-purpose modules.** The old engine died as an 11,560-line
   runner. Any file approaching 500 lines is a design smell; justify it or split it.
2. **The kernel is small and pure.** `kernel/` (Rust) holds journal, scheduler,
   leases, durable timers, streams. No provider SDKs, no product logic, no
   tenant awareness, no I/O in core logic — built against a simulated clock.
3. **The journal protocol is the boundary.** SDKs and surfaces speak it; nothing
   reaches around it.
4. **Fail closed.** A journal write that fails fails the step. No silent
   fallbacks, no `console.warn` where an error belongs. Every completion carries
   a `completionReason`.
5. **Tests pin deterministic code.** Every kernel behavior has a test; the
   crash-injection tests (kill between and during steps, resume, assert
   exactly-once effects) are the gate, not a nice-to-have.
6. **No dead code, no speculative abstraction.** Build what the current gate
   needs. The ladder grows rung by rung.
7. **Match the RFC's vocabulary.** Step types are `deterministic`, `llm`,
   `agent`. Journal entries carry the names in RFC §1 and Appendix A.

## Rails

- **Never commit to `main`.** Branch, PR, wait for review. A human merges.
- **Never edit a gate that judges your own work.**
- **Report honestly.** If tests fail, say so with output. Unverified work is
  unfinished work.

## Observability

Every workflow run MUST join the canonical cloud workspace so humans can follow
it live (observer links, channels). The broker is pinned via
`agent-relay workspace rebind default`; launch runs through
`scripts/run-workflow.sh`. A run that lands in an ephemeral/local workspace is
a defect (Nabis #7 family) — fix the binding, don't proceed silently.

## Evidence is captured, not narrated

Six consecutive review rounds on one PR rejected on *claims about evidence*
rather than on the code, which was largely right. The recurring shape: a
report asserts "mutation-verified", "re-executed", or "all seven cases pass",
and the reviewer finds the claim does not reproduce.

Therefore:

1. **Every verification claim carries the literal command and its captured
   output.** Not a summary of the output — the output. If you cannot paste it,
   you may not make the claim.
2. **"Mutation-verified" has one meaning:** you reverted the specific change,
   ran the specific test, captured its failure, restored the change
   byte-for-byte, and re-ran to capture the pass. Paste both. Anything less is
   not mutation verification and must not be labeled as such.
3. **Cite paths that exist.** A transcript path in a report is checked; a
   wrong one reads as fabrication even when the work is real.
4. **Prefer a smaller true claim to a larger unverifiable one.** "F1 fixed,
   F2 not attempted" beats "all findings addressed" that fails on inspection.

The code being right does not rescue a report that is wrong. A reviewer can
only judge what it can check.
