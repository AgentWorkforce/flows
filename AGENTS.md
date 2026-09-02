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

Prefer launching runs through `scripts/run-workflow.sh`, which pins the broker
to the canonical cloud workspace so humans can follow a run live via observer
links and channels. That is how a run becomes watchable, and for any run a
human may need to follow it is the right default.

**It is not a correctness requirement, and a local run is not a defect.**
RFC-0001 settled decision 7 makes relaycast a *projection, not a source of
truth*: the journal is the record, and the workspace is one view onto it. A run
that never joins a workspace is harder to watch; it is not less durable, less
resumable, or less correct.

This paragraph previously said every run MUST join the canonical workspace and
that anything else was a defect. That predates decision 7 and outlived it — it
caused a review to flag a local demo as a P1 defect when the demo was fine.
A stale MUST is worse than a missing one: it spends reviewer attention, and it
teaches people the rules are approximate.

### The observer link

A run is watchable at `https://agentrelay.com/observer?key=<token>`. The `key`
is always a scoped `ot_live_` observer token — **never** a `rk_live_` workspace
key. A workspace key can send messages, spawn and remove agents, and change
settings; the engine rejects it on the realtime endpoint outright, so a link
built from one cannot even stream. Mint a token instead:

```bash
agent-relay observer                      # read-only link, 24h, DMs excluded
agent-relay observer --channels wf-...    # scope it to one run's channel
agent-relay observer list                 # what is outstanding
agent-relay observer revoke <id>          # cut one off immediately
```

`scripts/run-workflow.sh` does this for you and prints the link before the run
starts. It also exports `RELAY_API_KEY` — the runner reads that and nothing
else, so without it the workspace pin is checked and then ignored, and the run
lands in a throwaway workspace whose key nobody ever sees. That failure is
silent: the run works, it is just unwatchable.

Note that `agent-relay workspace key` prints a **masked** key; the real material
needs `--reveal-secrets`.

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
