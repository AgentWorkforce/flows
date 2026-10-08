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

- **Never commit to `main`.** Branch, PR, wait for review. A human merges — with one
  narrow exception: the Relayflow Lead may merge under RFC-0001 settled decision #16
  (independent signoff at the exact head, green CI at that head, not a push-deploying
  branch, and not about its own authority or its gates). That exception is the Lead's
  alone and does not apply to you.
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

The observer link is the default way to watch a local run. `--cloud-mirror`
(or `FLOWS_CLOUD_MIRROR=1`) additionally puts the run on the Cloud dashboard,
which is the richer hosted view and therefore opt-in: it stores the flow
source, every step's transcript and the run's own output, so it happens because
someone asked and never because a login was present (`docs/CLOUD.md`, "Local
runs on the dashboard"). Both are projections — watchability, not authority —
and neither can fail a run.

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

<!-- prpm:snippet:start @agent-relay/merge-train-snippet@1.0.0 -->
## Merging: `trunk` + the `mergeable` label

CI does **not** run on feature branches. It runs only on the `trunk` → `main`
pull request and on pushes to `main`. (Repos whose default branch is not
`main`, e.g. `master`, use that branch wherever this says `main`.) A merge
agent batches ready PRs into `trunk`, gets that one PR green, and merges it.

**When you open a PR**
1. Branch from `trunk` and open the PR with **base `trunk`**, not `main`.
   A PR into `main` from any other branch fails the `Trunk guard` check.
2. No CI runs on your PR, so verify locally before calling it ready: run the
   typecheck, tests and lint this repo uses, and list the exact commands and
   results in the PR body.

**When the PR is ready**
3. Add the label **`mergeable`** once all of these are true:
   - The change is complete and the local checks above pass.
   - Review feedback (human and bot) is addressed or answered.
   - It is not a draft and does not depend on an unmerged PR.
4. Remove `mergeable` if the PR stops being ready (new work, a failing check, a
   blocking question). The label is read live from GitHub on every sweep.

**What you must not do**
- Do not merge your own PR, and never merge into or push to `trunk` or `main`
  directly.
- Do not re-enable CI for feature branches or edit the `trunk` gates in
  `.github/workflows/`.

**The merge agent** sweeps open `mergeable` PRs with base `trunk` about every
10 minutes. It reads each PR's linked sessions (the `Agent Relay sessions`
block in the PR body, then the session summary) for context, merges them into
`trunk`, opens or updates the `trunk` → `main` PR, fixes CI there, merges when
green, and posts a summary. If your PR conflicts with `trunk`, it may ask you
to rebase on `trunk`; do so and keep the label.

> Interim: the sweep worker is not deployed yet. Until it is, a human or a
> designated agent performs the merge-agent steps manually. Labelling is unchanged.
<!-- prpm:snippet:end @agent-relay/merge-train-snippet@1.0.0 -->
