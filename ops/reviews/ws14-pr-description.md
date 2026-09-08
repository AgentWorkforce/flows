`runInCloud` and `flows run --cloud` implement declarative submission to Cloud’s existing v2 API plus cancellable observation. The CLI reports acceptance and optionally waits with `--wait`; it starts no local daemon and requires no node enrollment. Cancelling observation does not cancel the hosted run.

**Scope settled by Khaliq’s 2026-09-08 ruling:**

- **Built:** SDK submission/observation and the thin CLI for authoring YAML/JSON and compiled kernel JSON.
- **Deliberately design-only:** gallery / `publishFlowRun`. Publishing requires a new endpoint in the Cloud repository, outside this lane, with no assigned owner. The written design in `docs/CLOUD-PUBLICATION-DESIGN.md` is the deliverable. No endpoint, export, gallery, or public URL was invented; implementation is not an acceptance dependency.
- **Cancelled, not deferred:** the landing page. No page will be built or deployed, and there is no target to wait for. Proposed deterministic gates + session replay + BYO CLI harness copy remains only as documentation in `docs/CLOUD.md`.
- **Live hosted proof: BLOCKED-ON-CREDENTIAL.** Exact captured result: `Authenticated Cloud-base-path read HTTP: 401`. No hosted success is claimed. This credential block does not hold review readiness under Khaliq’s ruling.

The client reuses the existing compiler, preserves the production `/cloud` base path, validates IDs/statuses, rejects credential-bearing redirects and Relay workspace/observer keys, and bounds individual HTTP requests without imposing a run deadline. Submission is not automatically retried because the API has no client idempotency guarantee.

Cloud’s current v2 bootstrap rejects authored TypeScript; the SDK refuses `.flow.ts` before HTTP. Cloud retains its separate one-hour execution deadline. No authored-flow executor, kernel, verifier, or gate changes are included.

Validation: the final rerun passes **63/63 CLI + 22/22 cloud tests (85/85)**. The earlier 62/63 wrapper-preflight failure is retained in the original transcript. It did not reproduce on either the pre-change revision `f0a3b3b` (full CLI 63/63) or WS-14 (full CLI 63/63), so its cause is unconfirmed; it is not established as a pre-existing defect or a cloud regression. The wrapper test, preflight implementation, and worker implementation are byte-for-byte unchanged against that revision. No tests, gates, or timeout limits were changed.

Final rerun from `packages/sdk` (literal command and output; full baseline/current transcript linked below):

```text
$ node node_modules/vitest/vitest.mjs run tests/cli.test.ts tests/cloud-run.test.ts --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /Users/khaliqgant/Projects/AgentWorkforce/.worktrees/ws14-flows-cloud/packages/sdk

 ✓ tests/cli.test.ts (63 tests) 3439ms
   ✓ flows check CLI > passes all three canonical ladder flows and prints their resolved CLI 360ms
 ✓ tests/cloud-run.test.ts (22 tests) 200ms

 Test Files  2 passed (2)
      Tests  85 passed (85)
   Start at  20:47:48
   Duration  5.01s (transform 539ms, setup 0ms, collect 906ms, tests 3.64s, environment 0ms, prepare 124ms)

EXIT CODE: 0
```

Prior SDK/type/test typechecks, build, and rebuilt-package CLI/SDK contract check passed; their literal commands/output are in the evidence below. The package check uses a local HTTP server, not hosted execution. Its six-minute dependency installation does not establish fresh-machine timing acceptance.

Commands and literal captured output are committed in [ws14-cloud.txt](ops/runtime-evidence/ws14-cloud.txt); the credential probe and HTTP 401 are in [ws14-cloud-auth.txt](ops/runtime-evidence/ws14-cloud-auth.txt). The baseline comparison is captured in [ws14-wrapper-baseline.txt](ops/runtime-evidence/ws14-wrapper-baseline.txt). Raw test-output whitespace is retained verbatim.

Three independent working-tree reviews covered Cloud contract correctness, security, and maintainability/architecture; their findings were addressed. These are not exact-head merge approval. Veto tools were not exposed in this session. Work is isolated on `feat/flows-run-in-cloud`; shared SDK entry-point changes are additive. **Ready for review; do not merge.**
