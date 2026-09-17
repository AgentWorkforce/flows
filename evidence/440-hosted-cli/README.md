# #440 hosted CLI — production evidence (2026-09-17)

Merged as a339a1e5; released as v2.0.16 (fe8d7606); Cloud production runtime
pin moved to the v2.0.16 artifact. Every proof below ran against
`https://agentrelay.com/cloud` with an `agent-relay cloud login` credential.

| Proof | Run / id | Result |
| --- | --- | --- |
| `flows run --cloud --sync-code --wait` (branch build) | 8701c899-c9f2-4a82-bba2-b78b3872e5c4 | `success`; gate on a file only present in the uploaded tree |
| executable bit + gitignored `.env` absent on host | 418dab2c-2b12-4b6a-aebe-849264da9683 | `success` |
| `flows deploy` / `deployments` / `undeploy` | listener 8b78c766-9b4e-44c2-b488-5486fbf729e8 | `DEPLOYED … listening` → `UNDEPLOYED` |
| listener launch from a real issue | listener 35147a1d-f576-456a-af8c-64cd7859c8c6, issue #443, run 4d9667d5-7f03-5e18-bac3-2c9275bae5c4 | run created 17 s after the issue; `workflow.completed`, 2/2 steps `success` |
| published CLI (`relayflows@2.0.16`) sync round trip | 83a6a6af-c0d4-4f0b-8da6-1e6f8dfce3a1 | `success`; `flows sync` applied `cloud.txt` — [npm-sync-roundtrip.txt](npm-sync-roundtrip.txt) |
| pinned runtime: `./run.sh` as first command word | 3d82bbd1-e139-49a7-87f9-e40f3d250d61 | `success` on `sourceCommit fe8d7606`; the same shape was refused `command_missing` on the previous runtime (fe1179db) — [pinned-runtime-command-path.txt](pinned-runtime-command-path.txt) |

Runtime artifact: `relayflow-v2-fe8d7606…-61469ea7a484786a-linux-x64.tar.gz`,
sha256 in [artifact-sha256.txt](artifact-sha256.txt) (computed, filename and
sidecar agree; `manifest.json.sourceCommit` = fe8d7606). Published to the
production S3 stage bucket by cloud run 35269932515; the R2 publication
(35269943738) failed `Missing R2 publication credentials` — the R2 secrets are
not on the production environment yet. Previous pin, for rollback:
[pin-before.txt](pin-before.txt).

`issue-echo.flow.ts` as recorded here single-quotes the issue text (review fix on #444); the smoke listener ran the pre-fix body, which interpolated the title through `JSON.stringify` — same behaviour for the benign title #443 carried, but an injection surface, hence the correction.

Cloud-side observations, not fixed here: a deployment-launched run's record
carries top-level `completionReason: null` although every step and the
`workflow.completed` event say `success`; the runs API exposes no step stdout.
