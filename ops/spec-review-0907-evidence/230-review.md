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
