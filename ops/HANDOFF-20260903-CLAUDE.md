# Relayflow v2 lead handoff — 2026-09-03

## Objective and non-negotiable migration invariant

Drive Relayflow v2 through a real Cloud execution proof with authoritative
exported journal bytes while preserving the existing v1 runtime. During the
migration window, omitted version selection remains v1; v2 is explicit,
authority-pinned, and rollback/epoch gated. Do not remove v1 or silently
reinterpret an existing v1 workflow. Deprecation is a later gate, after every
shipped Relayflow is inventoried and migrated, both paths have same-head proof,
rollback has been exercised, and an explicit removal decision is approved.

Read `AGENTS.md` and `docs/RFC-0001-everything-is-a-relayflow.md` before taking
repository action. Evidence claims require literal commands and captured
output. Never edit a gate that judges your own work. Do not merge anything;
Khaliq owns the current merge gate.

Issue #132 is in scope and defines seven slices:

1. typed outputs — PR #133, head `54361d7e0cbf5affa819395f61cdbf3295fd443f`
2. shipped `@relayflows/surface` — PR #134, head `5f2c0b9a22a7cab916980d49b5992f3cab041761`
3. direct input — PR #140, head `0987e3830584d6efc3c784a7d32a98d5d660a256`
4. declared `agents[].model` plus typo lint — PR #136, head `3fcf2dcbfcb056060b8f91e2ab6decfea5b34ba1`
5. production parallel dispatch — PR #137, remote head `78812c31d3a4e54bebd9d3e37054af14df61fc68`
6. data/code gates — PR #139, head `e6210a2fc666df6dc8c777c009712ddf99efa877`
7. verb-specific field refusal — PR #138, head `e164e4239b0aa9e8b2dd58ed126263d206ad29d0`

The integration draft is PR #144, current head
`9404a4e00026c081b85f86215e5bd94f766d5f2b`. It already captured one explicit
v2 direct-input run and a separate omitted-selector v1-default run, but it is
not releasable: current #136 and the pending #137 repair are not integrated,
and its inherited full suite is red.

## Active critical-path work

### Flows PR #134

Fresh signoff found three P1 lifecycle bypasses: native
`Promise.withResolvers` callbacks satisfy the await heuristic; nested handled
promise chains can forget an operation failure; and mutable
`Function.prototype.toString` can forge the callback-source test. Reports:

- `/Users/khaliqgant/AgentWorkforce/flows-pr134-signoff3a-wt/ops/reviews/20260902-2215-pr134-signoff3-structure.md`
- `/Users/khaliqgant/AgentWorkforce/flows-pr134-signoff3b-wt/ops/reviews/20260902-2215-pr134-signoff3-adversarial.md`

The original repair owner hit its usage limit before product edits. Ownership
was live-injected on 2026-09-03 to `flows-132-model-lint-r2`, working in
`/Users/khaliqgant/AgentWorkforce/flows-132-surface-wt`. It must replace
callback identity/source heuristics with an explicit fail-closed lifecycle
contract, reproduce all three P1s red, preserve legitimate await/Promise.all,
run packed/live/full gates, and push only after confirming the remote head.

### Flows PR #137

Remote head `78812c3` repaired forged rejected-completion pin projection, but a
second P1 remains. `/mount/repo` and `/mount/./repo` were admitted concurrently.
Owner `flows-132-parallel-r1` has uncommitted red/green repair work in
`/Users/khaliqgant/AgentWorkforce/flows-132-parallel-dispatch-wt`, including
canonical workspace/worktree identity tests across Rust, SDK, and real socket.
Inspect and resume this work; do not lose the WIP and do not accept `78812c3` as
complete.

### Model selection and headless adapter

PR #136 is pushed at `3fcf2dcb`. It includes declared model typo rejection,
closed wrapper environments, canonical wrapper identity, bounded handshake and
execution/output, and duplicate execute-frame refusal. Reported exact-head
evidence: wrapper 5/5, focused regressions 168/168, full SDK 344 passed with 3
skipped, installed-provider 3/3. It still needs fresh independent exact-head
signoff.

Issue #141 is implemented as draft PR #147, head
`193dd5f05fd86944386bae92c5f5890217b37b70`, stacked on current #136. Its owner
reported full SDK 349 passed / 4 skipped and a built-package headless adapter
smoke. Keep it draft until #136 is approved and the stack is reviewed.

### PRs #138 and #139

PR #139 has one fresh exact-head structural approval at `e6210a2`; the attempted
second local reviewer exited without a report. PR #138's attempted fresh
reviewers also exited without reports. Start new independent Codex reviewers
when local capacity exists; do not count a dispatched invocation or an offline
registration as a verdict.

### Cloud compatibility base PR #3264

Exact head `39f26bcd4a04dcf100ab9818f598cd39b12e041e` passed full hosted CI run
`33677970885` and Drizzle run `33677970601`. Fresh signoff A passed. Fresh
signoff B correctly returned NO-GO:

- the 0117 latest snapshot contains `relayflow_v2_authority` even though #3264
  has no matching schema/migration; that table belongs to #3270/0118;
- invalid requested selectors authenticate before rejection;
- malformed stored schedule selectors can be re-encrypted/written.

Report:
`/Users/khaliqgant/AgentWorkforce/cloud-pr3264-signoff3b-wt/ops/reviews/20260902-2220-pr3264-signoff3-adversarial.md`.
Owner `cloud-pr3264-repair-0902` was live-restarted in
`/Users/khaliqgant/AgentWorkforce/cloud-pr3264-repair-wt` and is working
red-first. Do not merge after repair until two fresh exact-head reviews pass.

### Cloud executor/proof PR #3270

Remote head is still `7a08d72b1e0a254ec10e94512e44bdfb911a36aa`.
The repair owner hit its usage limit, but all product work is safely committed
under `/Users/khaliqgant/AgentWorkforce/cloud-relayflow-v2-executor-wt` at local
head `3ce981c3a40393ccba57fa1538fffc6687372036`. This head descends from repaired
base `39f26bcd`; the branch reports ahead 14 / behind 12 because it was
restacked and has not been force-with-lease pushed. Three review reports are
staged and must not be folded into product commits.

Take this lane over. Inspect the committed proof changes, retrieve/capture the
completed background test output if available, rerun anything incomplete, and
only then update the PR branch with an exact lease. The final proof must:

- compare the expected authority tuple exactly: epoch, artifact key/SHA,
  source commit, protocol, and manifest;
- require exact expected step identities/count, exactly one terminal
  `run.completed`, and no post-terminal entries;
- use token lifetimes safe for both sequential polls;
- execute v2 in real Cloud and export authoritative journal bytes;
- separately prove an omitted-version v1 run still succeeds.

No local simulation, route mock, or control-plane acknowledgement satisfies the
goal.

### Relay selector PR #1640

Current head `e8a8eae494a5e222f550fbf4abfca7a543381cf1` is open and blocked on
repository review. Product/gate head `2c12c1c2` passed proof runs `33674697950`
and `33674697944`; `e8a8eae4` is a formatter-only test change. Owner
`relay-v2-selector-0902` must obtain current-head review disposition. Do not
merge.

## Migration/deprecation exit contract

Before any v1 deprecation proposal:

1. Produce a checked-in inventory of every shipped Relayflow and classify each
   `v1-only`, `v2-ready`, `migrated`, or `blocked`, with an owner and evidence.
2. Keep omitted selector behavior pinned to v1 throughout migration; use an
   explicit selector for v2 and reject unknown values before side effects.
3. Run a same-head compatibility matrix for every migrated flow: v1 success,
   v2 success, journal/completionReason assertions, and documented semantic
   differences.
4. Exercise rollback/kill-switch from v2 to the pinned v1 path without losing
   journal authority or duplicating effects.
5. Soak production canaries with observable failure budgets and no unresolved
   v2-only data migration reversal risk.
6. Reach zero unowned `v1-only` or `blocked` flows, publish migration guidance,
   and approve a removal RFC/issue separately. Only then may v1 default/removal
   be considered.

## Coordination and durability

- Use Agent Relay for all workers; do not use `claude -p`.
- Local broker cwd: `/tmp/relay-local-spawn-0902`.
- Reliable status command:
  `agent-relay node agent list | sed -n '/^\\[/,$p' | jq`.
- Durable lead worktree:
  `/Users/khaliqgant/AgentWorkforce/flows-lead-wt`.
- Shared `/Users/khaliqgant/AgentWorkforce/flows-ops` is reset every ~300 s by
  sanctioned `autodrive-D`; never put tracked work there.
- Chief is `chief` on SSH alias `kjg-lap`. Do not rely on DM delivery. Update
  `/Users/khaliqgant/Projects/AgentWorkforce/chief/.chief-inbox/from-<agent>.md`
  on that machine; short DMs may point to the file.
- A future observer iteration may inspect
  `/private/tmp/claude-501/-Users-khaliqgant-Projects-AgentWorkforce-relayflows/1abaaf69-4269-4add-9322-392f62096e9c/scratchpad/flows-observer-prompt.md`
  on `kjg-lap`. It is temporary and is not authoritative; do not spend the
  current critical path on it.
- Anything valuable under `/private/tmp` must be committed and pushed before
  parking. None of the unpushed #3270 product commits are under `/private/tmp`,
  but the PR branch still needs a verified remote update.

Continue the periodic productivity loop. An idle owner with uncommitted changes
or an exhausted usage allocation is a takeover signal, not a completion claim.
