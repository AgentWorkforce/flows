# Dev #455 named-stream worker failure and fix

Dev Cloud `3362eb8d43cb2882ddbb65309f02527624d6fb77` admitted runtime `0e549c37a74cfd61e34936e3d664f2619d463d02`. One scoped #455 fixture submission created Cloud run `46041b32-e6c8-488d-9c42-226bd356bf0d`, engine run `01M2ZWVRDBM0757P0578C4BT7S`.

The actual hosted journal proves the deterministic sync step succeeded with `SYNC_MATERIALIZED=ok` and `SYNC_MODE=snapshot`. The flow then parked before its first agent attempt because the local worker held only a random stream, while the flow declared `flows-drive-cloud`. Cloud already supplied `--local-agent`; the missing flag was not the cause. No agent work package, final report, or diff was produced. Cloud recorded failed / `needs_human`; cancellation returned HTTP 409 `Run already failed`. That is not a cleanup-success claim. No durable state was deleted.

The SDK now registers the ordinary agent steps' declared stream names, using offset zero because this worker has consumed no stream messages. Resume reads names from the immutable journaled spec. Workspace revision pins are never invented; kernel matching and offset fencing remain authoritative. Communication-owned stream registration remains with communication workers. Authored TypeScript behavior is unchanged. This change does not address the separate declarative LLM worker gap.

## Captured commands and output

Each `.log` contains its literal command and full output. Commands ran with `TMPDIR=/home/khaliqgant/.cache/dev-pr-proof` exported; the built daemon was explicitly selected with `RELAYFLOWD_BIN=/tmp/flows-pr-followup/pr441/kernel/target/debug/relayflowd`. SDK dependencies were shared read-only through the existing PR441 node_modules symlink, while this checkout has its own dist build. The untracked symlink is not committed.

- `stream-baseline-build.log`: original implementation build success.
- `stream-regression-red-with-resume.log`: new named-stream run/resume tests reproduced no eligible worker, 6 failed / 2 passed. This is baseline regression evidence, not mutation verification.
- `stream-fix-build.log`: fixed SDK build success.
- `stream-regression-green.log`: intermediate 4-failure test run retained. Agent execution had succeeded; the new spec-immutability assertion incorrectly expected `workspace: []` where the authored spec omitted workspace. Corrected that new expectation to preserve the original shape.
- `stream-regression-green-final.log`: final real-daemon wrapper, named-stream run/resume, workspace refusal, communication worker and stream-selection suites: 5 files / 36 tests passed. The command also named a nonexistent `communication-spec.test.ts`; Vitest ran only the five listed files. No sixth suite is claimed.
- `stream-types.log`: test TypeScript compilation success.
- `stream-diff-check.log`: git diff check success before evidence was added.
- `cloud-dev-drive-launch.log`, `cloud-dev-drive-status.log`, `cloud-dev-drive-logs.log`, `cloud-dev-drive-patch.log`: actual hosted submission and failure evidence.
- `drive-journal.log`: read-only snapshot SQL, with run.spawned intentionally projected to names/types/surfaces; all other entries printed in full.
- `drive-export.log`: successful durable snapshot export digest. Export and SQLite retained locally in `/home/khaliqgant/.cache/dev-pr-proof/drive-export.bin`, `drive-snapshot.tar.gz`, `drive-run.sqlite3`.
- `drive-cancel.log`: HTTP409, not successful resource cleanup.

An earlier build in `/tmp/flows-dev-stream-pins` failed because the user's tmpfs quota was exhausted, and even the evidence write failed. Its tool output reported TS5033 writes and OSError122. The checkout was copied/repaired to the home cache before the captured successful baseline build; no gate or dependency constraint was changed.

This is local regression proof against a real daemon with a deterministic stub CLI. A fresh hosted #455 attempt on the new published artifact remains required for acceptance.
