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
