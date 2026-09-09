# Journal client close: cause and verification

The launcher shares one connection between the worker and status polling.
`step.complete` calls `Engine::complete_out_of_band`, which drives downstream
commands before returning (`kernel/relayflowd/src/engine/remote.rs`). The server
handles requests serially per connection (`kernel/relayflowd/src/server.rs`).
Consequently a downstream command lasting over 30 seconds times out both the
bounded completion request and any status read queued behind it. The worker
error handler closes the shared client, masking the cause as `closed by caller`.
Cleanup and journal pagination are consequences, not the initiating close.

The fix gives the local worker a separate connection, treats `step.complete`
like the other run-driving lifecycle calls (no bounded request timer), drains
the completion acknowledgement before publishing success, and preserves the
worker error when closing the control connection interrupts polling. Bounded
requests still have timeouts; protocol rejections, disconnects, and explicit
close still reject pending completions.

## Reproduce before changing code

Initial checkout: `dd3880b` (no heartbeat). SDK installed with:

```sh
cd packages/sdk
npm ci --userconfig /tmp/empty-npmrc --prefer-offline --no-audit --no-fund
```

The supplied `workflows/drive-local.yaml` in this checkout is the old
deterministic F8b flow, not the agent flow on the other lane. Its selector
refuses because F8b is already applied. The exact requested launcher invocation
and full exit-1 output are [captured here](evidence/journal-close-0909/checked-in-drive.txt).
Running its selector directly captures the explanation:
[command and output](evidence/journal-close-0909/checked-in-selector.txt).
No other lane's worktree, branch, or gate was changed to bypass this refusal.

For the journal-close reproduction, a wrapper emits `DONE`, then a deterministic
step runs `sleep 35; printf VERIFIED`, then `report` prints `REPORTED`. This uses
the real daemon and journal protocol, with no model call. Exact archived inputs:
[wrapper](evidence/journal-close-0909/agent.mjs.txt),
[spec](evidence/journal-close-0909/slow-followup.json.txt), and
[diagnostic preload](evidence/journal-close-0909/trace.mjs.txt). The preload only
logs worker errors and close stacks; it delegates to the original methods.
These archives contain this worktree's absolute paths. Restore them under
`.relayflow/journal-close-evidence/` (without `.txt`, wrapper executable) on this
checkout to repeat the recorded commands. The committed regression tests below
generate portable equivalents without a preload for the success case.

1. Without #249: [literal command and complete output](evidence/journal-close-0909/before-no-heartbeat.txt).
   Exit 1; `WORKER_ERROR ... step.complete timed out after 30000ms`, followed by
   a close from the worker error handler and `journal client: closed by caller`.
2. Integrated #249 at `33297fa` into this lane for compatibility testing:

   ```sh
   git merge --no-edit origin/lane/agent-lease-renewal-0909
   node packages/sdk/node_modules/typescript/bin/tsc -p packages/sdk/tsconfig.json
   ```

   The integration commit was `005263f`. The unchanged reproducer again exited
   1 with the same cause: [literal command and complete output](evidence/journal-close-0909/before-with-heartbeat.txt).
   This establishes that the failure predates the heartbeat.
3. With the fix and #249: [literal command and complete output](evidence/journal-close-0909/after-with-heartbeat.txt).
   Exit 0, three successful completions (`implement`, `verify`, `report`), and
   `run.completed` with `completionReason: success`. The raw exported
   [journal](evidence/journal-close-0909/completed.journal.jsonl) is included.

## Regression and mutation evidence

The launcher regression waits 32 real seconds after the agent exits. It asserts
all three successful step completions, the report output, the exported journal,
the terminal run reason, exit 0, and daemon socket removal. A separate test sends
a wrong idempotency key to the real daemon and requires the original completion
rejection and exit 1. The SDK tests cover delayed acknowledgements and fail-closed
rejection, disconnect, and caller-close behavior.

For each mutation, the fixed file's bytes were saved, that file was replaced
with `git show HEAD:<path>` at integration commit `005263f`, and the named tests
were run. A Python `finally` restored the saved bytes and asserted equality.
The failed commands and their full output are preserved:

- [Launcher reverted, SDK fixed](evidence/journal-close-0909/mutation-launcher.txt):
  two failures, including `run.get timed out after 30000ms`.
- [SDK reverted](evidence/journal-close-0909/mutation-sdk.txt):
  delayed-completion test fails with `step.complete timed out after 10ms`.

After restoration, [the SDK command and complete output](evidence/journal-close-0909/restored-sdk-tests.txt)
record 29 passes, including #249's heartbeat tests. The corresponding
[launcher command and complete output](evidence/journal-close-0909/restored-launcher-tests.txt)
record six passes. These are mutation-verified changes, with both failure and
restored-pass transcripts above.

The integration merge is removed from the delivery branch so this PR contains
only the independent fix; #249 remains owned by its original PR. Final checks
on that standalone branch are captured in
[final-checks.txt](evidence/journal-close-0909/final-checks.txt).

## Limits

This proves the failure and its correction through a real local cell using a
deterministic agent wrapper. It does not claim a live Claude drive tick or that
the checked-in F8b workflow completed: that workflow refused at selection as
recorded above. The daemon was reused from
`/Users/khaliqgant/.relayflows-toolchain/target/3497393500/debug/relayflowd`;
no kernel changes or rebuild were needed. A live connection whose downstream
execution never returns is not bounded by `step.complete`'s request timer,
consistent with `run.start` and `run.resume`; workflow execution bounds and
connection failure remain the relevant limits.
