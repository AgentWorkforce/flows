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
