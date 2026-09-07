# Relayflow v2 spec review — 2026-09-07

Reviewed in assigned order: #232, #229, #230, #231, #227. Read RFC-0001 fully before edits and each full PR diff. All five are **left open**. Fixes were pushed to each existing PR branch; no rival PR, gate edit, cloud repository edit, or merge was made. This report records a cutoff, not a claim that later GitHub activity is covered.

The initial CI failures were captured 401 authentication failures. Credentials recovered externally; reruns launched, but #229/#230/#231/#227 then failed with fresh lens transcripts MISSING. Those failures are neither content signoff nor a reason to weaken the review gate. #232 changed externally twice; its final diff was reread at b9d030b and its final-head review was in progress at capture.

Evidence files beside this report contain literal commands, unabridged output, exit codes, full diffs, review thread snapshots, and posted review receipts. Earlier review text is historical: final disposition reviews below supersede its earlier credential/pending status. No mutation-verification claim is made. New #227 regressions were demonstrated failing before the repair and passing after; #231 uses process-kill failure injection.

## #232 — Authentication probe and credential fingerprint

Final reviewed head: `b9d030bd5fefb3834a1c8abaad348a16934c22df`. [Actual final PR review](https://github.com/AgentWorkforce/flows/pull/232#pullrequestreview-5135450327).

The latest head removes the temporary canary diagnostic seen at d7df77c; the full diff was read again. The original curl timeout/transport/non-auth error finding remains at `.github/workflows/review-swarm.yml:75-81` and its thread remains unresolved. No gate edits by this reviewer (RFC decision #6). Independent gate owner must repair the probe on this branch. Latest-head review is still running; no green-CI claim. Leave open regardless of that run until the content finding is resolved.

### Spec findings, changes, and captured verification

Spec review at 1a43d2ff5865f5094983175d139247718bcae28c: BLOCKED / leave open.

This serves RFC-0001 covenant 2 (check authentication before starting) and §2 rule 7 (a real review swarm, not a green vendor check). The fingerprint helps diagnose credential mismatch without printing the credential.

Blocking content finding: `.github/workflows/review-swarm.yml:75-81` invokes curl without connect/total timeouts, hides curl failures behind `|| echo 000`, and recommends credential rotation for every non-200 response, including transport failures and server errors. Bound the probe and distinguish transport/HTTP failures from 401. The existing unresolved thread discussion_r3952636976 remains valid.

The current `review` failure is credential infrastructure, not a content verdict. Literal command: `gh run view 34163837060 --log-failed`. Captured relevant output:
```
review	Validate cloud authentication	2026-09-07T21:38:11.3476428Z ##[error]CLOUD_API_KEY is set but not accepted by https://agentrelay.com/cloud (HTTP 401). Re***mint the credential; do not re***run this job.
review	Validate cloud authentication	2026-09-07T21:38:11.3487776Z ##[error]Process completed with exit code 1.
```

No gate edit performed: this workflow judges my assigned work, so settled decision #6 prohibits me from changing it. An independent gate owner must repair the probe on this PR branch; the cloud credential owner must restore accepted CI credentials and rerun at the final head. Leave open until those changes, real independent review, green CI at that head, and resolution of the outstanding thread. No merge attempted.


### Final CI and unresolved threads

```text
$ gh api repos/AgentWorkforce/flows/commits/b9d030bd5fefb3834a1c8abaad348a16934c22df/check-runs --jq '[.check_runs[] | {name,head_sha,status,conclusion,details_url}]'
[{"conclusion":null,"details_url":"https://github.com/AgentWorkforce/flows/actions/runs/34165035497/job/101874831362","head_sha":"b9d030bd5fefb3834a1c8abaad348a16934c22df","name":"review","status":"in_progress"},{"conclusion":"success","details_url":"https://www.cubic.dev/pr/AgentWorkforce/flows/pull/232","head_sha":"b9d030bd5fefb3834a1c8abaad348a16934c22df","name":"cubic · AI code reviewer","status":"completed"}]

exit_code=0
```

[Captured review threads](spec-review-0907-evidence/232-disposition-threads.txt). [Full diff](spec-review-0907-evidence/232-disposition-diff.txt).

**Disposition: left open.** The latest head removes the temporary canary diagnostic seen at d7df77c; the full diff was read again. The original curl timeout/transport/non-auth error finding remains at `.github/workflows/review-swarm.yml:75-81` and its thread remains unresolved. No gate edits by this reviewer (RFC decision #6). Independent gate owner must repair the probe on this branch. Latest-head review is still running; no green-CI claim. Leave open regardless of that run until the content finding is resolved.

## #229 — Derive lens verdict from Blockers

Final reviewed head: `a7b23cff7f394e16a77d02bc727be958365b8ae9`. [Actual final PR review](https://github.com/AgentWorkforce/flows/pull/229#pullrequestreview-5135450392).

The P1 false pass at `ops/preswarm-check/lens-runner.sh:285` and P2 first-section parser at `:264` remain reproduced and unresolved. An independent gate owner must repair both verdict arms and final exact section selection on this branch (RFC decision #6 prevents this assigned reviewer from modifying the gate). The rerun passed launch but failed with all three fresh lens transcripts MISSING. Review infrastructure owner must restore real transcripts and rerun. Leave open.

### Spec findings, changes, and captured verification

Spec review at a7b23cff7f394e16a77d02bc727be958365b8ae9: BLOCKED / leave open.

Serves RFC-0001 §2 rule 7 and decision #11: quality verdicts belong to the evidence layer. However the requested deterministic correspondence between Blockers and the final token is incomplete.

P1 — `ops/preswarm-check/lens-runner.sh:285`: the REVIEW_PASSED arm never validates Blockers; a review that lists unauthorized writes as a blocker and ends in REVIEW_PASSED exits 0. That fails closed-gate discipline (covenant 2 / §2 rule 4).

P2 — `ops/preswarm-check/lens-runner.sh:264`: awk stops at the first matching heading/body, accepts arbitrary heading levels, and does not isolate a section. A later genuine blocker is mislabeled CONTRADICTION when an earlier Blockers section said None. The comment promises the LAST exact heading.

I executed the classifier extracted verbatim from the stated head (no gate edits and no full preswarm approval claimed). Captured command and output:
```
$ python3 ops/spec-review-0907-evidence/229-classifier-repro.py
blocker_plus_pass: exit=0
PRESWARM_structure: REVIEW_PASSED
first_none_last_blocker: exit=1
PRESWARM_structure: CONTRADICTION — review says 'Blockers: None' but emitted REVIEW_FAILED; treating as NO_VERDICT (gate defect, not a finding)
none_plus_fail: exit=1
PRESWARM_structure: CONTRADICTION — review says 'Blockers: None' but emitted REVIEW_FAILED; treating as NO_VERDICT (gate defect, not a finding)

exit_code=0
```

Both existing review threads remain unresolved and valid. Required repair: an independent gate owner must validate the final exact Blockers section in BOTH verdict arms and pin malformed/multiple-section behavior with tests, on this PR branch. Decision #6 prohibits me from editing the review gates judging this assignment.

CI is separately blocked on credentials, not a content verdict. Captured command: `gh run view 34124184705 --log-failed`; relevant literal output:
```
review	Launch cloud swarm	2026-09-07T20:44:33.0836035Z Workflow prepare failed: 401 Unauthorized: Unauthorized
```
The credential owner must restore CI authentication and rerun at the final head. No merge attempted.


### Final CI and unresolved threads

```text
$ gh api repos/AgentWorkforce/flows/commits/a7b23cff7f394e16a77d02bc727be958365b8ae9/check-runs --jq '[.check_runs[] | {name,head_sha,status,conclusion,details_url}]'
[{"conclusion":"failure","details_url":"https://github.com/AgentWorkforce/flows/actions/runs/34124184705/job/101873935143","head_sha":"a7b23cff7f394e16a77d02bc727be958365b8ae9","name":"review","status":"completed"},{"conclusion":"success","details_url":"https://www.cubic.dev/pr/AgentWorkforce/flows/pull/229","head_sha":"a7b23cff7f394e16a77d02bc727be958365b8ae9","name":"cubic · AI code reviewer","status":"completed"}]

exit_code=0
```

[Captured review threads](spec-review-0907-evidence/229-disposition-threads.txt). [Full diff](spec-review-0907-evidence/229-diff.txt).

[Final failed-run output](spec-review-0907-evidence/229-disposition-swarm-log.txt). [Captured swarm comments](spec-review-0907-evidence/229-disposition-comments.txt).

**Disposition: left open.** The P1 false pass at `ops/preswarm-check/lens-runner.sh:285` and P2 first-section parser at `:264` remain reproduced and unresolved. An independent gate owner must repair both verdict arms and final exact section selection on this branch (RFC decision #6 prevents this assigned reviewer from modifying the gate). The rerun passed launch but failed with all three fresh lens transcripts MISSING. Review infrastructure owner must restore real transcripts and rerun. Leave open.

## #230 — Deterministic restack verification flow

Final reviewed head: `82297638ec8c4f18ac5acd355134d20c78a1b08c`. [Actual final PR review](https://github.com/AgentWorkforce/flows/pull/230#pullrequestreview-5135450451).

The branch contains repairs abf4442 and 8229763 and 16 passing local fixture tests, as captured in the earlier review. A remaining P2 at `ops/restack-verify/migration-journal.sh:67` is valid: scanning every historical snapshot means a legitimate DROP TABLE or table rename permanently triggers the loss guard. The guard cannot distinguish that from stale content and currently has no scoped restack baseline or semantic replay. This is not comprehensive restack acceptance. The restack flow owner must define the comparison baseline or implement semantic replay and exercise both stale snapshots and legitimate historical drops/renames. Removing the loss guard would recreate the previous P1 and is not a fix. The latest review failed with all fresh lens transcripts MISSING; review infrastructure owner must restore the swarm. Leave open with the unresolved thread; no merge.

### Spec findings, changes, and captured verification

Spec review: original bd7fda328ece342851e4ab57d6729e941e3c19a8; fixes pushed on this PR branch at abf4442d3902041318423d1ad20e10ff770550da. Leave open pending credential repair and independent review.

This is a zero-agent deterministic relayflow, serving RFC-0001 §1/Gate 1 and §2 dogfooding with existing primitives (decision #13). It is a standalone restack checker, not the review/merge gate judging this assignment; those gates were not edited.

Findings fixed on this branch:
- `ops/restack-verify/no-conflict-markers.sh:8`: Git errors falsely passed and lockfiles were excluded. Check exit 1 separately, surface errors, scan lockfiles, and use a private temporary file instead of a shared /tmp path.
- `ops/restack-verify/migration-journal.sh:18,39,47`: require entries, strictly increasing timestamps, and snapshot id/prevId lineage; the prior code never checked the documented prevId chain.
- The old table-loss heuristic rejected legitimate DROP TABLE migrations. Replaced with structural lineage validation; documentation now explicitly says SQL/schema equivalence requires database replay and target repo suites run separately.
- `ops/restack-verify/worker-bindings.sh:11`: missing configuration was mislabeled missing script. Both absent is inapplicable; a partial installation fails naming the actual missing path.

Added black-box temporary-repository tests. This is local fixture evidence, not a claim that a deployed consumer or full workflow ran. Captured command/output (also committed in ops/restack-verify/SPEC-REVIEW-EVIDENCE.md):
```
$ python3 ops/restack-verify/test_checks.py
test_bindings_inapplicable_skips (__main__.RestackChecks) ... ok
test_bindings_missing_config_fails (__main__.RestackChecks) ... ok
test_bindings_missing_script_fails (__main__.RestackChecks) ... ok
test_bindings_passes_config_argument (__main__.RestackChecks) ... ok
test_bindings_propagates_checker_failure (__main__.RestackChecks) ... ok
test_broken_snapshot_chain_fails (__main__.RestackChecks) ... ok
test_clean_tracked_file_ignores_untracked_markers (__main__.RestackChecks) ... ok
test_empty_journal_passes (__main__.RestackChecks) ... ok
test_equal_or_out_of_order_timestamps_fail (__main__.RestackChecks) ... ok
test_git_error_fails (__main__.RestackChecks) ... ok
test_lockfile_conflicts_fail (__main__.RestackChecks) ... ok
test_missing_entries_fails (__main__.RestackChecks) ... ok
test_missing_sql_fails (__main__.RestackChecks) ... ok
test_orphan_sql_fails (__main__.RestackChecks) ... ok
test_valid_drop_is_not_a_stale_snapshot (__main__.RestackChecks) ... ok

----------------------------------------------------------------------
Ran 15 tests in 0.375s

OK

exit_code=0
```

New-head CI still cannot perform the content review. `gh run view 34164170263 --log-failed` captured:
```
review	Launch cloud swarm	2026-09-07T21:44:38.3541771Z Workflow prepare failed: 401 Unauthorized: Unauthorized
```
The CI credential owner must restore accepted credentials. Independent reviewers must examine abf4442, acknowledge the fixes in outstanding threads, and provide genuine signoff. No merge or green-CI claim.


The first repair removed the table-loss heuristic; independent review correctly rejected the lost content signal. The following correction supersedes that part of the initial review:

Follow-up spec review at 82297638ec8c4f18ac5acd355134d20c78a1b08c. Leave open pending completed CI and independent signoff.

The review of abf4442 correctly identified that lineage-only validation lost the original stale-table signal. This head restores a fail-closed table-content check: removal of a table between snapshots requires semantic schema verification. The diagnostic explicitly distinguishes the unresolved possibilities (intentional drop or stale snapshot); it does not silently accept either and adds no override. SQL/schema equivalence and execution of the target repo suites remain outside this structural check.

The remaining original repairs (Git errors/lockfiles, malformed journals, strict timestamps, id/prevId chain, partial worker installation) are retained. Captured command/output, also in ops/restack-verify/SPEC-REVIEW-EVIDENCE.md:
```
$ python3 ops/restack-verify/test_checks.py
test_bindings_inapplicable_skips (__main__.RestackChecks) ... ok
test_bindings_missing_config_fails (__main__.RestackChecks) ... ok
test_bindings_missing_script_fails (__main__.RestackChecks) ... ok
test_bindings_passes_config_argument (__main__.RestackChecks) ... ok
test_bindings_propagates_checker_failure (__main__.RestackChecks) ... ok
test_broken_snapshot_chain_fails (__main__.RestackChecks) ... ok
test_clean_tracked_file_ignores_untracked_markers (__main__.RestackChecks) ... ok
test_empty_journal_passes (__main__.RestackChecks) ... ok
test_equal_or_out_of_order_timestamps_fail (__main__.RestackChecks) ... ok
test_git_error_fails (__main__.RestackChecks) ... ok
test_lockfile_conflicts_fail (__main__.RestackChecks) ... ok
test_missing_entries_fails (__main__.RestackChecks) ... ok
test_missing_sql_fails (__main__.RestackChecks) ... ok
test_orphan_sql_fails (__main__.RestackChecks) ... ok
test_table_loss_requires_semantic_verification (__main__.RestackChecks) ... ok
test_valid_lineage_passes (__main__.RestackChecks) ... ok

----------------------------------------------------------------------
Ran 16 tests in 0.421s

OK

exit_code=0
```

CI infrastructure has changed: Actions run 34164770687 now completed `Launch cloud swarm` successfully at 2026-09-07T21:54:49Z and is waiting for the swarm. The earlier 401 is historical, not the current blocker. This is not a content pass or permission to bypass the outstanding review thread. Await the final verdict and independent acknowledgement at 8229763. No merge.


### Final CI and unresolved threads

```text
$ gh api repos/AgentWorkforce/flows/commits/82297638ec8c4f18ac5acd355134d20c78a1b08c/check-runs --jq '[.check_runs[] | {name,head_sha,status,conclusion,details_url}]'
[{"conclusion":"success","details_url":"https://www.cubic.dev/pr/AgentWorkforce/flows/pull/230","head_sha":"82297638ec8c4f18ac5acd355134d20c78a1b08c","name":"cubic · AI code reviewer","status":"completed"},{"conclusion":"failure","details_url":"https://github.com/AgentWorkforce/flows/actions/runs/34164770687/job/101873532992","head_sha":"82297638ec8c4f18ac5acd355134d20c78a1b08c","name":"review","status":"completed"}]

exit_code=0
```

[Captured review threads](spec-review-0907-evidence/230-disposition-threads.txt). [Full diff](spec-review-0907-evidence/230-diff.txt).

[Final failed-run output](spec-review-0907-evidence/230-final-swarm-log.txt). [Captured swarm comments](spec-review-0907-evidence/230-disposition-comments.txt).

**Disposition: left open.** The branch contains repairs abf4442 and 8229763 and 16 passing local fixture tests, as captured in the earlier review. A remaining P2 at `ops/restack-verify/migration-journal.sh:67` is valid: scanning every historical snapshot means a legitimate DROP TABLE or table rename permanently triggers the loss guard. The guard cannot distinguish that from stale content and currently has no scoped restack baseline or semantic replay. This is not comprehensive restack acceptance. The restack flow owner must define the comparison baseline or implement semantic replay and exercise both stale snapshots and legitimate historical drops/renames. Removing the loss guard would recreate the previous P1 and is not a fix. The latest review failed with all fresh lens transcripts MISSING; review infrastructure owner must restore the swarm. Leave open with the unresolved thread; no merge.

## #231 — Local launcher and executed F8b package

Final reviewed head: `521e07c175ecd09b058f490b470bf337709850af`. [Actual final PR review](https://github.com/AgentWorkforce/flows/pull/231#pullrequestreview-5135450497).

The bounded local launcher/F8b changes pass this spec review after 521e07c; this is Gate 1/local protocol evidence, not full Gate 7 deployment or heartbeat/isolation proof. The remaining test-count thread has the literal rerun showing 63 CLI plus 28 parity tests; an independent reviewer must acknowledge that evidence and resolve the thread. Latest-head artifact and packed-consumer checks succeeded, but the review rerun failed with all three fresh lens transcripts MISSING after successful launch. Review infrastructure owner must restore the swarm and obtain real signoff at this head. Leave open; no merge.

### Spec findings, changes, and captured verification

Spec review: original dc7a33a8a11a70196a212bcf6b68fd8425bdf533; fixes pushed on this PR branch at 521e07c175ecd09b058f490b470bf337709850af. Leave open pending green CI and independent review.

The bounded local deterministic launcher serves RFC-0001 Gate 1 and §2 dogfooding. It talks to the existing journal protocol; decision #7 makes Relaycast optional projection, so absence of a cloud workspace is not a correctness defect. The F8b rename keeps the authoring restriction unchanged. This is not full Gate 7 acceptance, sealed-bundle deployment (decision #14), or proof of long-running agent execution.

Findings/fixes:
- `ops/local-work-package.mjs:40`: an interrupted write could truncate the target and make retries refuse it. Both the package record and source replacement now use a same-directory temporary file, flush before atomic rename, then directory fsync. The original byte/hash guard remains.
- `scripts/run-local-workflow.test.mjs:10,20`: fixtures/run directories leaked. Registered suite cleanup retains files until assertions finish, then removes the owned directories.
- `ops/runtime-evidence/workflow-summary.txt:3`: transformed JSON was presented alongside commands without identifying the transformation. Replaced it with fresh, full CLI output and exit codes for all seven workflows.
- The existing claim that `drive-verify.txt:9` overstates test count is NOT reproduced. Running the exact source yields 63 CLI plus 28 parity tests, 91 total. Do not rewrite a real transcript based on a static miscount.

Captured commands/output (also committed under ops/runtime-evidence/spec-review-*.txt):
```
$ node --test scripts/run-local-workflow.test.mjs ops/local-work-package.test.mjs
✔ interrupted package write preserves the original and retry applies once (243.952833ms)
✔ local launcher journals deterministic effects and reads more than one journal page (601.889709ms)
✔ a failed command fails the run and prevents dependent effects (130.195167ms)
✔ the SDK worker completes an agent step through the local journal protocol (595.823584ms)
✔ missing daemon is refused before a data directory or run is created (62.254666ms)
ℹ tests 5
ℹ suites 0
ℹ pass 5
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 1429.743458

exit_code=0
```
```
$ node node_modules/vitest/vitest.mjs run tests/spec-parity.test.ts tests/cli.test.ts

 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-runtime-0907-wt/packages/sdk

 ✓ tests/spec-parity.test.ts (28 tests) 153ms
 ✓ tests/cli.test.ts (63 tests) 2492ms
   ✓ flows check CLI > binds a checked relative wrapper to the flow directory for worker execution 474ms
   ✓ flows check CLI > uses the raw Claude adapter model flag instead of accepting auth status as model proof 306ms

 Test Files  2 passed (2)
      Tests  91 passed (91)
   Start at  23:44:42
   Duration  2.86s (transform 166ms, setup 0ms, collect 408ms, tests 2.64s, environment 0ms, prepare 76ms)


exit_code=0
```
The new kill-during-write test is failure injection, not a claim of full mutation verification. Existing kernel crash evidence in the PR is historical; I did not rerun the full kernel crash suite for this JS/package-write repair. The bounded launcher still documents missing worker heartbeat, workspace isolation/reset, and bare-LLM support; these are not proven by its wrapper wiring check.

CI at the new head still cannot review content. `gh run view 34164420311 --log-failed` captured:
```
review	Launch cloud swarm	2026-09-07T21:48:38.4926158Z Workflow prepare failed: 401 Unauthorized: Unauthorized
```
The CI credential owner must restore accepted authentication; independent reviewers must review 521e07c and close the outstanding threads based on the fixes and reproduction evidence. No merge or green-CI claim.


### Final CI and unresolved threads

```text
$ gh api repos/AgentWorkforce/flows/commits/521e07c175ecd09b058f490b470bf337709850af/check-runs --jq '[.check_runs[] | {name,head_sha,status,conclusion,details_url}]'
[{"conclusion":"failure","details_url":"https://github.com/AgentWorkforce/flows/actions/runs/34164420311/job/101873938274","head_sha":"521e07c175ecd09b058f490b470bf337709850af","name":"review","status":"completed"},{"conclusion":"success","details_url":"https://www.cubic.dev/pr/AgentWorkforce/flows/pull/231","head_sha":"521e07c175ecd09b058f490b470bf337709850af","name":"cubic · AI code reviewer","status":"completed"},{"conclusion":"success","details_url":"https://github.com/AgentWorkforce/flows/actions/runs/34164420328/job/101872524987","head_sha":"521e07c175ecd09b058f490b470bf337709850af","name":"linux-x64-artifact","status":"completed"},{"conclusion":"success","details_url":"https://github.com/AgentWorkforce/flows/actions/runs/34164420307/job/101872524549","head_sha":"521e07c175ecd09b058f490b470bf337709850af","name":"packed-consumer","status":"completed"}]

exit_code=0
```

[Captured review threads](spec-review-0907-evidence/231-disposition-threads.txt). [Full diff](spec-review-0907-evidence/231-diff.txt).

[Final failed-run output](spec-review-0907-evidence/231-disposition-swarm-log.txt). [Captured swarm comments](spec-review-0907-evidence/231-disposition-comments.txt).

**Disposition: left open.** The bounded local launcher/F8b changes pass this spec review after 521e07c; this is Gate 1/local protocol evidence, not full Gate 7 deployment or heartbeat/isolation proof. The remaining test-count thread has the literal rerun showing 63 CLI plus 28 parity tests; an independent reviewer must acknowledge that evidence and resolve the thread. Latest-head artifact and packed-consumer checks succeeded, but the review rerun failed with all three fresh lens transcripts MISSING after successful launch. Review infrastructure owner must restore the swarm and obtain real signoff at this head. Leave open; no merge.

## #227 — Step placement and workspace pins

Final reviewed head: `733cf17a216234cc08f284444910a279c4c1553d`. [Actual final PR review](https://github.com/AgentWorkforce/flows/pull/227#pullrequestreview-5135450540).

The P1 closed-vocabulary and P1 source-revision drift findings in the earlier review remain blocking at 733cf17. Khaliq/spec owner must settle the exact routing contract under decision #13; placement author must then preserve/reject source drift across resume using the approved durable representation. The four integrity fixes do not establish Gate 7 acceptance. Latest-head artifact and packed-consumer checks succeeded, but the review failed with all fresh lens transcripts MISSING. Review infrastructure owner must restore the swarm. Existing stale descriptor thread also needs acknowledgement of captured SDK evidence; source-pin drift thread remains valid. Leave open regardless of CI.

### Spec findings, changes, and captured verification

Spec review: original 8bbafca34b6fb15556b67b374da0625dd65d11ea; integrity fixes pushed on this PR branch at 733cf17a216234cc08f284444910a279c4c1553d. BLOCKED: leave open.

P1 — RFC-0001 decision #13 / the explicit vocabulary constraint for this review. `kernel/relayflowd-core/src/entry.rs:28` adds the `step.routed` entry type; `entry.rs:393` adds `epoch.summary.routing`; `spec.rs:348` adds the kernel `requirements` schema, and `kernel/relayflowd/src/worker.rs:19` adds dispatch routing. Gate 7 does require journaled routing evidence, but RFC-0001 does not specify these exact additions or their compatibility contract. This is a blocking specification question, not a naming nit. Khaliq/spec owner must settle the contract explicitly or require lowering through existing facts; I have not amended the spec to approve my work.

P1 — `kernel/relayflowd/src/engine/placement.rs:163` rereads HEAD instead of preserving the source revision across resume. The route persists only a path, so the run can switch source commits between steps and still complete successfully. This contradicts the source continuity required by Gate 7 / Appendix A's pin chain. The remaining correction depends on the agreed durable representation; I did not invent another field to paper over the vocabulary blocker. Literal reproduction (script and output also committed in kernel/evidence/225/spec-review-source-drift-repro.*):
```
$ python3 ops/spec-review-0907-evidence/227-source-drift-repro.py /Users/khaliqgant/AgentWorkforce/flows-225-placement-wt/kernel/target/debug/relayflowd
$ git init -q
exit_code=0
$ git add source.txt
exit_code=0
$ git -c user.name=Fixture -c user.email=fixture@example.test -c commit.gpgsign=false commit -qm original
exit_code=0
$ /Users/khaliqgant/AgentWorkforce/flows-225-placement-wt/kernel/target/debug/relayflowd --data-dir /var/folders/yv/nbp9l2c55wlbj1x0gml37s7c0000gn/T/placement-drift-dsqt865h/data run /var/folders/yv/nbp9l2c55wlbj1x0gml37s7c0000gn/T/placement-drift-dsqt865h/flow.json --stop-after 1
{"run_id":"01M1YXR74Z6RWZMCYJ8HW9SY9S","status":"interrupted","completion_reason":null,"completed_steps":1}
exit_code=0
$ git add source.txt
exit_code=0
$ git -c user.name=Fixture -c user.email=fixture@example.test -c commit.gpgsign=false commit -qm changed
exit_code=0
$ /Users/khaliqgant/AgentWorkforce/flows-225-placement-wt/kernel/target/debug/relayflowd --data-dir /var/folders/yv/nbp9l2c55wlbj1x0gml37s7c0000gn/T/placement-drift-dsqt865h/data resume 01M1YXR74Z6RWZMCYJ8HW9SY9S
{"run_id":"01M1YXR74Z6RWZMCYJ8HW9SY9S","status":"completed","completion_reason":"success","completed_steps":2}
exit_code=0
{"entry_type": "step.attempt.started", "step": "first", "pins": {"streams": [], "workspace": [{"revision_id": "c2df7c0316d15be56f8cb282cd67da83a70c7704", "surface": "/private/var/folders/yv/nbp9l2c55wlbj1x0gml37s7c0000gn/T/placement-drift-dsqt865h/tree"}]}, "output": null}
{"entry_type": "step.completed", "step": "first", "pins": null, "output": {"exit_code": 0, "stderr_tail": "", "stdout_tail": "original\n"}}
{"entry_type": "step.attempt.started", "step": "second", "pins": {"streams": [], "workspace": [{"revision_id": "14f735f5866363a1de0b1fef8faa1200c6d0e7f8", "surface": "/private/var/folders/yv/nbp9l2c55wlbj1x0gml37s7c0000gn/T/placement-drift-dsqt865h/tree"}]}, "output": null}
{"entry_type": "step.completed", "step": "second", "pins": null, "output": {"exit_code": 0, "stderr_tail": "", "stdout_tail": "changed-between-steps\n"}}

exit_code=0
```

Integrity fixes made without further vocabulary additions:
- `kernel/relayflowd-core/src/state/routing.rs:8`: reject attempt-scoped routing entries during replay, matching journal admission.
- `kernel/relayflowd-journal/src/placement.rs:47`: validate raw epoch routing before commit, including unknown steps/malformed decisions and attempts to drop or replace durable routes.
- `kernel/relayflowd/src/workspace.rs:11`: peel HEAD with `HEAD^{commit}` and refuse non-commit objects.

Four focused regressions failed before these fixes and passed after. Complete literal before/after commands and outputs are committed in `kernel/evidence/225/spec-review-regressions-before.txt` and `spec-review-regressions-after.txt`. This is not labeled mutation verification. After-fix captured output:
```
$ env RUSTC=/Users/khaliqgant/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc /Users/khaliqgant/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo test --manifest-path kernel/Cargo.toml --locked --offline --test spec_review_routing
   Compiling relayflowd-core v0.1.0 (/Users/khaliqgant/AgentWorkforce/flows-225-placement-wt/kernel/relayflowd-core)
   Compiling relayflowd-journal v0.1.0 (/Users/khaliqgant/AgentWorkforce/flows-225-placement-wt/kernel/relayflowd-journal)
   Compiling relayflowd v0.1.0 (/Users/khaliqgant/AgentWorkforce/flows-225-placement-wt/kernel/relayflowd)
    Finished `test` profile [unoptimized + debuginfo] target(s) in 2.99s
     Running tests/spec_review_routing.rs (kernel/target/debug/deps/spec_review_routing-a37130322a188264)

running 4 tests
test attempt_scoped_route_is_rejected_at_append_and_replay ... ok
test malformed_epoch_routes_are_rejected_before_commit ... ok
test epoch_cannot_drop_or_replace_a_durable_route ... ok
test workspace_pin_peels_tags_and_refuses_non_commit_objects ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.10s


exit_code=0
```

The complete kernel workspace command/output is in `kernel/evidence/225/spec-review-kernel-tests-final.txt`, including 40 crash/resume tests. The first workspace attempt failed during doctests because ambient rustdoc differed from selected rustc; that failed output remains in `spec-review-kernel-tests.txt`. Matching RUSTC/RUSTDOC fixed the environment mismatch without code/gate changes. SDK captured output:
```
$ node node_modules/vitest/vitest.mjs run tests/placement.test.ts tests/spec-parity.test.ts tests/verb-field-lint.test.ts

 RUN  v2.1.9 /Users/khaliqgant/AgentWorkforce/flows-225-placement-wt/packages/sdk

 ✓ tests/placement.test.ts (54 tests) 11ms
 ✓ tests/spec-parity.test.ts (31 tests) 226ms
 ✓ tests/verb-field-lint.test.ts (78 tests) 518ms
   ✓ closed per-verb step fields > carries the llm/agent `output` sugar through every path > flows check accepts output on llm 321ms

 Test Files  3 passed (3)
      Tests  163 passed (163)
   Start at  23:52:12
   Duration  1.23s (transform 359ms, setup 0ms, collect 1.16s, tests 755ms, environment 0ms, prepare 170ms)


exit_code=0
```

The earlier descriptor snapshot and blank routing-field findings were already addressed at the reviewed head; other outstanding threads need acknowledgement of the actual fixes. CI was previously credential-blocked; the newly pushed head must earn its own checks. Passing tests cannot override the two P1 findings above. No merge.


The full final workspace command and output follow, including crash/resume and doctests. The failed first run is retained in [227-kernel-tests.txt](spec-review-0907-evidence/227-kernel-tests.txt); its rustdoc/compiler mismatch was corrected through environment selection only.

<details>
<summary>Full kernel workspace verification</summary>

```text
$ env RUSTC=/Users/khaliqgant/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustc RUSTDOC=/Users/khaliqgant/.rustup/toolchains/stable-aarch64-apple-darwin/bin/rustdoc /Users/khaliqgant/.rustup/toolchains/stable-aarch64-apple-darwin/bin/cargo test --manifest-path kernel/Cargo.toml --locked --offline --workspace
    Finished `test` profile [unoptimized + debuginfo] target(s) in 0.38s
     Running unittests src/lib.rs (kernel/target/debug/deps/relayflowd-7cc6b6adaeba2a85)

running 36 tests
test engine::remote::worker_failure_detail_tests::a_null_or_blank_output_yields_no_detail ... ok
test engine::remote::worker_failure_detail_tests::a_non_string_output_is_rendered_rather_than_dropped ... ok
test engine::remote::worker_failure_detail_tests::an_output_at_the_boundary_is_not_truncated ... ok
test engine::remote::worker_failure_detail_tests::a_string_output_is_carried_verbatim_and_trimmed ... ok
test engine::remote::worker_failure_detail_tests::truncation_does_not_split_a_multi_byte_char ... ok
test engine::boot_identity_tests::every_engine_in_this_process_shares_one_boot_id ... ok
test server::client::tests::resume_waits_while_the_heartbeat_renewed_lease_is_live ... ok
test server::liveness::tests::sweep_id_buckets_by_the_interval ... ok
test server::channels::tests::unknown_verb_never_falls_through_to_receive ... ok
test exec_det::tests::captures_deterministic_output ... ok
test exec_det::tests::timeout_has_an_explicit_completion_reason ... ok
test server::liveness::tests::sweep_pass_healthy_subscription_is_a_noop ... ok
test server::liveness::tests::sweep_pass_latches_after_journaling_and_next_bucket_is_empty ... ok
test engine::wake::claim_guard_tests::a_disarmed_guard_leaves_the_claim_alone ... ok
test server::tests::agent::contract::an_agent_worker_attaching_without_pins_is_refused_at_attach ... ok
test engine::wake::claim_guard_tests::a_guard_only_releases_its_own_run ... ok
test engine::wake::claim_guard_tests::an_armed_guard_releases_the_claim_when_dropped ... ok
test server::tests::agent::contract::an_oversized_trajectory_tail_is_refused_at_step_complete ... ok
test engine::wake::claim_guard_tests::a_panic_between_claim_and_register_still_releases ... ok
test server::tests::agent::contract::an_agent_worker_missing_a_declared_surface_parks_the_run_instead_of_erroring ... ok
test server::tests::hello_enforces_protocol_version ... ok
test server::tests::agent::contract::agent_without_a_compatible_worker_parks_without_starting ... ok
test server::tests::run_resume_asks_the_registry_instead_of_treating_an_orphan_file_as_a_run ... ok
test server::tests::agent::contract::a_replacement_worker_that_never_reported_the_pinned_surface_is_not_dispatched_to ... ok
test server::tests::agent::contract::an_llm_completion_claiming_an_effect_fails_closed_with_the_reason_journaled ... ok
test server::tests::a_failed_disconnect_journal_append_is_retained_and_retried_not_dropped ... ok
test server::tests::run_start_fails_closed_on_an_unknown_verification_key ... ok
test server::tests::run_resume_refuses_a_journal_that_never_recorded_its_run ... ok
test server::tests::agent::pins::reset_worker_reporting_a_revision_other_than_its_pin_fails_closed_as_worker_error ... ok
test server::tests::run_resume_adopts_a_real_journal_whose_registry_row_is_missing ... ok
test server::tests::agent::pins::consecutive_agent_steps_on_different_surfaces_each_start_from_their_own_pins ... ok
test server::tests::run_resume_refuses_a_valid_journal_that_belongs_to_another_run ... ok
test server::tests::stopped_heartbeats_past_the_deadline_journal_lease_expired_and_release_the_step ... ok
test exec_det::tests::timeout_kills_the_whole_process_group ... ok
test server::tests::agent::pins::a_replacement_worker_at_a_different_revision_is_not_dispatched_the_stale_pins ... ok
test server::tests::an_entry_appended_during_watch_registration_is_delivered_exactly_once ... ok

test result: ok. 36 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.58s

     Running unittests src/main.rs (kernel/target/debug/deps/relayflowd-a3a150c1162c49ec)

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

     Running tests/crash_resume.rs (kernel/target/debug/deps/crash_resume-8980b58a474e7aba)

running 40 tests
test agent::resume_without_a_worker_parks_immediately_instead_of_timing_out ... ok
test concurrency::cancel_and_completion_race_has_one_terminal_fact ... ok
test agent::rung_c_sigkill_after_final_effect_replays_results_without_redispatch ... ok
test concurrency::cancel_closes_the_lease_and_rejects_a_late_completion ... ok
test channels::channels_reject_foreign_workers_stale_attempts_and_invalid_acknowledgements ... ok
test agent::rung_c_sigkill_between_agent_completion_and_final_effect_memoizes_the_agent ... ok
test concurrency::concurrent_resumes_lease_exactly_one_attempt ... ok
test concurrency::live_resume_leaves_an_active_lease_running ... ok
test concurrency::run_start_dispatches_every_independent_lane_before_any_completion ... ok
test agent::rung_c_crash_between_effect_election_and_the_provider_call_performs_it_exactly_once ... ok
test concurrency::server_restart_recovers_every_parallel_lease_without_duplicate_success ... ok
test agent::rung_c_reset_sigkill_mid_edit_restores_pins_dedupes_effect_and_explains_attempts ... ok
test llm::failing_llm_verification_schedules_a_durable_retry_and_succeeds ... ok
test llm::serve_plumbs_watch_events_and_replayable_stream_verbs ... ok
test llm::completed_llm_output_is_memoized_when_serve_dies_during_the_next_step ... ok
test llm::llm_verification_exhaustion_is_a_declared_failure_kind ... ok
test llm::sigkill_after_the_final_rung_b_effect_resumes_without_redispatching_llm ... ok
test agent::rung_c_sigkill_boundaries_resume_only_unfinished_steps_via_real_cli ... ok
test memory::memory_sigkill_after_injection_replays_pack_and_charges_it_once ... ok
test llm::worker_killed_while_holding_a_lease_is_explained_and_released_on_cli_resume ... ok
test llm::sigkill_under_serve_mid_llm_releases_the_lease_and_finishes_via_cli_resume ... ok
test pin_projection::rejected_completion_cannot_forge_inspect_retry_pins_over_the_real_socket ... ok
test protocol_admission::every_mutating_run_verb_refuses_terminal_before_changing_state ... ok
test parallel_lifecycle::overlapping_agent_conflict_survives_server_crash_and_resume ... ok
test placement::declared_placement_keeps_one_source_tree_across_resume ... ok
test placement::sigkill_mid_step_keeps_the_route_and_source_tree ... ok
test placement::sigkill_before_first_step_preserves_the_submitted_workspace ... ok
test parallel_lifecycle::overlapping_agent_lanes_serialize_while_disjoint_lanes_merge_in_either_order ... ok
test parallel_lifecycle::terminal_failure_drains_or_explains_every_live_sibling ... ok
test sigkill_after_cancel_request_resumes_to_one_canceled_fact ... ok
test sigkill_mid_step_replaces_and_explains_the_dead_attempt ... ok
test llm::sigkill_sweep_covers_before_and_between_the_rung_b_steps ... ok
test surface_identity::aliases_are_rejected_and_external_ancestors_serialize_over_real_sockets ... ok
test worker_capacity::two_workers_receive_a_deterministic_fair_capacity_bounded_batch ... ok
test sigkill_under_serve_resumes_the_socket_started_run ... ok
test workspace_identity::workspace_aliases_are_refused_and_canonical_subtrees_serialize_over_real_sockets ... ok
test worker_capacity::default_capacity_one_reopens_only_after_durable_completion_or_crash ... ok
test channels::channels_sigkill_resume_redelivers_unacked_messages_with_exactly_once_effects ... ok
test sigkill_sweep_covers_every_hello_step_boundary ... ok
test parallel_lifecycle::renewed_parallel_leases_survive_the_original_grant_and_remain_distinct ... ok

test result: ok. 40 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 37.53s

     Running tests/event_wake.rs (kernel/target/debug/deps/event_wake-694cba08f5e199b7)

running 3 tests
test two_racing_deliveries_of_one_event_produce_exactly_one_run ... ok
test matching_event_wakes_once_with_fresh_context ... ok
test a_resumed_run_dispatches_the_original_wake_context ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.07s

     Running tests/hn_monitor_integration.rs (kernel/target/debug/deps/hn_monitor_integration-712d52524bb3367c)

running 1 test
test hn_story_event_wakes_monitor_once_with_story_context ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.06s

     Running tests/invalid_schema_preflight.rs (kernel/target/debug/deps/invalid_schema_preflight-c3ac725a2193ec68)

running 3 tests
test invalid_json_schema_is_refused_before_journal_or_command ... ok
test unbounded_json_schema_is_refused_before_journal_or_command ... ok
test legitimately_recursive_json_schema_still_starts ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 5.56s

     Running tests/memory.rs (kernel/target/debug/deps/memory-a5944bc39239e789)

running 5 tests
test rejected_journal_fact_releases_reservation_and_never_dispatches ... ok
test llm_dispatch_receives_same_pack_after_resume_without_provider ... ok
test replay_and_resume_need_no_provider_and_script_receives_recorded_pack ... ok
test over_budget_and_provider_errors_fail_without_dispatch_or_charge ... ok
test semantic_retry_reuses_memory_without_a_second_charge ... ok

test result: ok. 5 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.06s

     Running tests/memory_epoch.rs (kernel/target/debug/deps/memory_epoch-53e5ca10ed87e9cb)

running 1 test
test epoch_carries_pack_and_exact_charge_and_refuses_duplicate_injection ... ok

test result: ok. 1 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s

     Running tests/parallel_driver.rs (kernel/target/debug/deps/parallel_driver-2af26d6a5e052c55)

running 4 tests
test stop_after_one_holds_for_an_independent_deterministic_batch ... ok
test backpressured_or_mismatched_lane_does_not_drop_a_later_dispatch ... ok
test crash_boundaries_resume_the_real_driver_with_one_effect_per_lane ... ok
test pause_before_second_independent_step_holds_the_driver_boundary ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.09s

     Running tests/placement_pins.rs (kernel/target/debug/deps/placement_pins-3ca6f44ccad88596)

running 2 tests
test unsupported_local_pty_is_refused_before_an_earlier_step_can_run ... ok
test default_worker_pins_the_declared_worktree_base_commit_and_refuses_missing_source ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.05s

     Running tests/placement_routing.rs (kernel/target/debug/deps/placement_routing-11acbd842d4a637e)

running 3 tests
test a_failed_routing_append_never_starts_or_dispatches_work ... ok
test crash_between_routing_and_start_does_not_redecide ... ok
test worker_retry_consumes_the_original_routing_fact ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s

     Running tests/routing_diagnostics.rs (kernel/target/debug/deps/routing_diagnostics-2e576930d54bdbaf)

running 2 tests
test duplicate_routes_have_a_distinct_diagnostic_and_leave_the_original_fact_intact ... ok
test malformed_routes_name_the_same_field_at_append_replay_and_epoch_replay ... ok

test result: ok. 2 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s

     Running tests/spec_review_routing.rs (kernel/target/debug/deps/spec_review_routing-a37130322a188264)

running 4 tests
test attempt_scoped_route_is_rejected_at_append_and_replay ... ok
test malformed_epoch_routes_are_rejected_before_commit ... ok
test epoch_cannot_drop_or_replace_a_durable_route ... ok
test workspace_pin_peels_tags_and_refuses_non_commit_objects ... ok

test result: ok. 4 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.07s

     Running tests/subscription_liveness.rs (kernel/target/debug/deps/subscription_liveness-14d251638e2a76c8)

running 3 tests
test submit_event_upserts_subscription_row_and_sweep_flags_it_stale_after_budget ... ok
test stale_transition_is_journaled_as_subscription_stale_entry_in_the_last_known_run ... ok
test a_fresh_arrival_re_arms_the_latch_and_the_next_silence_can_stale_again ... ok

test result: ok. 3 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.04s

     Running unittests src/lib.rs (kernel/target/debug/deps/relayflowd_core-81c19dffa1c9ee81)

running 60 tests
test clock::tests::simulated_clock_is_explicitly_advanced ... ok
test journal::tests::memory_journal_assigns_sequences_and_rolls_epochs ... ok
test channel::tests::malformed_payloads_and_invalid_new_channel_appends_leave_state_unchanged ... ok
test channel::tests::forged_deliveries_and_acknowledgements_fail_closed ... ok
test channel::tests::send_retry_is_stable_and_conflicting_content_is_rejected ... ok
test channel::tests::delivery_replay_and_independent_acknowledged_offsets ... ok
test machine::parallel_tests::workspace_ancestor_and_descendant_paths_conflict_but_siblings_do_not ... ok
test machine::parallel_tests::external_ancestor_and_descendant_paths_conflict_but_siblings_do_not ... ok
test machine::tests::all_backing_off_steps_return_timers ... ok
test machine::parallel_tests::every_declared_mutable_surface_participates_in_conflict_selection ... ok
test machine::parallel_tests::machine_starts_every_runnable_step_in_authored_order ... ok
test machine::tests::every_reason_label_matches_its_serialized_form ... ok
test machine::tests::durable_cancel_request_outranks_crash_recovery ... ok
test machine::parallel_tests::crash_resume_preserves_each_parallel_lease_exactly_once ... ok
test machine::tests::cancel_request_closes_the_active_lease_before_the_terminal_fact ... ok
test machine::tests::machine_starts_runnable_step_with_stable_effect_key ... ok
test machine::parallel_tests::overlapping_agent_surfaces_are_serialized_in_authored_order ... ok
test machine::tests::repeated_cancel_request_is_idempotent ... ok
test machine::tests::inspect_recovery_injects_the_dirty_pin_completion_reason_and_tail ... ok
test machine::parallel_tests::parallel_lanes_do_not_cross_the_dependency_barrier_early ... ok
test machine::tests::successful_memo_is_never_scheduled_again ... ok
test machine::tests::crashed_attempt_does_not_consume_an_iteration ... ok
test machine::tests::verification_failure_schedules_a_durable_retry ... ok
test machine::tests::worker_reported_failure_without_detail_still_records_a_verification ... ok
test machine::parallel_tests::failed_run_drains_open_siblings_before_terminal_entry ... ok
test memory::tests::caps_compare_exact_decimals_and_each_token_dimension ... ok
test machine::tests::reset_recovery_dispatches_the_original_pinned_revision ... ok
test machine::tests::manual_recovery_parks_needs_human_and_never_redispatches ... ok
test retry::tests::jitter_is_repeatable_and_bounded ... ok
test machine::tests::every_failed_run_terminates_with_declared_completion_reasons ... ok
test machine::parallel_tests::disjoint_agent_lanes_merge_pins_in_either_completion_order ... ok
test spec::tests::a_misspelled_step_level_key_is_a_parse_error ... ok
test spec::tests::a_misspelled_verification_gate_key_is_a_parse_error_not_a_dropped_gate ... ok
test spec::tests::cycles_are_rejected ... ok
test spec::tests::preflight_data_is_fail_closed ... ok
test spec::tests::external_surface_paths_must_have_one_canonical_spelling ... ok
test schema::tests::in_document_uri_references_resolve_to_the_node_they_name ... ok
test schema::tests::refusal_names_the_cycle_it_found ... ok
test spec::tests::spec_version_is_semver_and_gated ... ok
test spec::tests::unknown_root_and_nested_fields_are_rejected ... ok
test spec::tests::workspace_mounts_and_worktrees_must_have_one_canonical_spelling ... ok
test spec::tests::zero_agent_flow_is_valid ... ok
test state::budget::tests::adds_costs_exactly_beyond_machine_decimal_precision ... ok
test state::budget::tests::overflow_and_malformed_cost_leave_total_unchanged ... ok
test state::tests::a_completion_that_omits_a_surface_does_not_drop_it_from_the_pin_chain ... ok
test state::tests::budget_decimal_strings_add_without_floats ... ok
test schema::tests::references_the_bound_leaves_opaque_are_refused_by_the_engine ... ok
test state::tests::end_pin_chain_is_enforced_and_a_broken_chain_is_a_hard_error ... ok
test state::tests::journal_replays_data_gate_verdict_without_rerunning_completed_code ... ok
test verify::tests::deterministic_output_requires_successful_exit_and_content ... ok
test verify::tests::an_unbounded_schema_in_a_journal_fails_its_gate_instead_of_aborting ... ok
test spec::tests::the_full_ladder_parses_in_the_one_dialect ... ok
test verify::tests::json_schema_is_a_control_gate ... ok
test schema::tests::a_property_named_ref_is_not_a_reference ... ok
test schema::tests::shared_declarations_and_boolean_schemas_are_validated ... ok
test schema::tests::every_accepted_corpus_schema_is_accepted ... ok
test schema::tests::every_refused_corpus_schema_compiles_but_is_refused_by_the_bound ... ok
test spec::tests::sdk_boundary_rejects_a_10_000_step_cycle_with_a_typed_error ... ok
test spec::tests::sdk_boundary_accepts_a_valid_10_000_step_reverse_chain ... ok
test schema::tests::deeply_nested_schemas_do_not_overflow_the_checker ... ok

test result: ok. 60 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.59s

     Running tests/spec_parity.rs (kernel/target/debug/deps/spec_parity-2e346aa0d81e3bc8)

running 9 tests
test step_memory_has_identical_canonical_bytes_and_hash ... ok
test the_kernel_parses_the_deterministic_rung_and_stamps_the_same_hash ... ok
test placement_requirements_have_identical_canonical_bytes_and_hash ... ok
test the_kernel_parses_the_event_triggered_spec_and_stamps_the_same_hash ... ok
test the_kernel_parses_the_rung_c_agent_spec_and_stamps_the_same_hash ... ok
test memory_declaration_acceptance_matches_the_sdk_corpus ... ok
test placement_declaration_acceptance_matches_the_sdk_corpus ... ok
test the_kernel_parses_the_sdk_compiled_spec_and_stamps_the_same_hash ... ok
test the_kernel_parses_the_rung_b_spec_and_stamps_the_same_hash ... ok

test result: ok. 9 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.03s

     Running unittests src/lib.rs (kernel/target/debug/deps/relayflowd_journal-a18eeb9f7cf88775)

running 28 tests
test registry::tests::a_pre_migration_registry_gains_boot_id_and_its_claims_are_repairable ... ok
test registry::tests::a_previous_boots_claim_with_no_run_is_repaired ... ok
test registry::tests::releasing_a_claim_lets_the_same_boot_retry ... ok
test registry::tests::a_registered_run_dedupes_across_boots ... ok
test registry::tests::a_same_boot_claim_with_no_run_yet_is_a_duplicate_not_wreckage ... ok
test registry::tests::registry_is_a_rebuildable_run_locator ... ok
test subscriptions::tests::last_run_for_subscription_returns_none_before_first_arrival ... ok
test registry::tests::releasing_is_scoped_to_the_claiming_run ... ok
test subscriptions::tests::detect_without_latch_stays_available_for_the_next_sweep ... ok
test subscriptions::tests::prune_sweep_claims_deletes_only_rows_older_than_cutoff ... ok
test subscriptions::tests::last_run_for_subscription_returns_the_lex_greatest_ulid_regardless_of_insertion ... ok
test subscriptions::tests::latch_is_a_no_op_if_a_fresh_event_arrived_between_detect_and_latch ... ok
test subscriptions::tests::sweep_does_not_re_emit_the_same_stale_row_on_a_later_tick ... ok
test subscriptions::tests::sweep_election_gives_the_first_caller_the_result_and_second_gets_empty ... ok
test subscriptions::tests::sweep_ignores_subscriptions_whose_silence_is_still_within_budget ... ok
test subscriptions::tests::sweep_marks_row_stale_when_silence_exceeds_budget ... ok
test subscriptions::tests::upsert_after_stale_re_arms_and_next_silence_can_re_emit ... ok
test subscriptions::tests::upsert_is_idempotent_across_bumps_and_preserves_event_type_updates ... ok
test tests::failed_commit_is_returned_not_swallowed ... ok
test tests::terminal_run_refuses_every_later_entry_atomically ... ok
test tests::effects_are_deduplicated_at_the_journal_boundary ... ok
test tests::append_is_durable_and_monotonic_after_reopen ... ok
test tests::rollover_is_atomic_scaffolding_for_epoch_resume ... ok
test tests::an_unconfirmed_election_is_reclaimed_by_the_next_attempt_not_treated_as_done ... ok
test channel::tests::stale_attempts_and_raw_forged_acknowledgements_cannot_change_offsets ... ok
test channel::tests::channels_cross_segment_boundaries_and_terminal_runs_reject_mutations ... ok
test channel::tests::failed_channel_writes_never_expose_delivery_or_advance_acknowledged_offset ... ok
test channel::tests::independent_connections_serialize_send_receive_and_acknowledgement ... ok

test result: ok. 28 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.34s

   Doc-tests relayflowd

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests relayflowd_core

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s

   Doc-tests relayflowd_journal

running 0 tests

test result: ok. 0 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.00s


exit_code=0
```

</details>

### Final CI and unresolved threads

```text
$ gh api repos/AgentWorkforce/flows/commits/733cf17a216234cc08f284444910a279c4c1553d/check-runs --jq '[.check_runs[] | {name,head_sha,status,conclusion,details_url}]'
[{"conclusion":"success","details_url":"https://www.cubic.dev/pr/AgentWorkforce/flows/pull/227","head_sha":"733cf17a216234cc08f284444910a279c4c1553d","name":"cubic · AI code reviewer","status":"completed"},{"conclusion":"failure","details_url":"https://github.com/AgentWorkforce/flows/actions/runs/34164872298/job/101873821752","head_sha":"733cf17a216234cc08f284444910a279c4c1553d","name":"review","status":"completed"},{"conclusion":"success","details_url":"https://github.com/AgentWorkforce/flows/actions/runs/34164872290/job/101873821719","head_sha":"733cf17a216234cc08f284444910a279c4c1553d","name":"packed-consumer","status":"completed"},{"conclusion":"success","details_url":"https://github.com/AgentWorkforce/flows/actions/runs/34164872285/job/101873821552","head_sha":"733cf17a216234cc08f284444910a279c4c1553d","name":"linux-x64-artifact","status":"completed"}]

exit_code=0
```

[Captured review threads](spec-review-0907-evidence/227-disposition-threads.txt). [Full diff](spec-review-0907-evidence/227-diff.txt).

[Final failed-run output](spec-review-0907-evidence/227-disposition-swarm-log.txt). [Captured swarm comments](spec-review-0907-evidence/227-disposition-comments.txt).

**Disposition: left open.** The P1 closed-vocabulary and P1 source-revision drift findings in the earlier review remain blocking at 733cf17. Khaliq/spec owner must settle the exact routing contract under decision #13; placement author must then preserve/reject source drift across resume using the approved durable representation. The four integrity fixes do not establish Gate 7 acceptance. Latest-head artifact and packed-consumer checks succeeded, but the review failed with all fresh lens transcripts MISSING. Review infrastructure owner must restore the swarm. Existing stale descriptor thread also needs acknowledgement of captured SDK evidence; source-pin drift thread remains valid. Leave open regardless of CI.
