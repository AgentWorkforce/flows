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
