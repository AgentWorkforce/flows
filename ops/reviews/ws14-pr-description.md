`runInCloud` submits declarative flows to Cloud's existing v2 execution API. `flows run --cloud` calls that SDK function, reports acceptance, and optionally waits with `--wait`; it starts no local daemon and requires no node enrollment. Requests preserve the production `/cloud` base path and never fall back to v1.

The client reuses the compiler for authoring YAML/JSON and compiled kernel JSON, validates server IDs/statuses, refuses credential-bearing redirects and Relay workspace/observer keys, and bounds individual HTTP requests without imposing a run deadline. Submission is not retried because the current API has no client idempotency guarantee.

The showcase deliverables follow the revised scope:

- **Built:** SDK declarative submission and cancellable observation, plus the thin CLI.
- **Design only, deliberately not built:** gallery and Cloud run-publication API. `docs/CLOUD-PUBLICATION-DESIGN.md` specifies endpoint shapes, the token/authorization model, visibility tiers, public-record contents, replay consent, and revocation. Cloud surface ownership is unidentified. There is no standalone app, gallery site/route, backend implementation, or `publishFlowRun` export in this change.
- **Landing rewrite prepared:** `docs/LANDING-COPY.md` contains the complete hero, feature sections, availability copy, and CTAs headlining deterministic gates + session replay + BYO CLI harness. Applying/deploying it is blocked on identifying the existing landing repository/path. This PR does not claim a deployed page or modify WS-13's README rewrite.
- **Live proof: BLOCKED-ON-CREDENTIAL.** Exact captured result: `Authenticated Cloud-base-path read HTTP: 401`. No hosted proof is claimed and no further credential pursuit is part of this lane.

Cloud's current v2 bootstrap accepts YAML/JSON and rejects authored TypeScript. `runInCloud(authoredFlow)` cannot work end to end today; the SDK refuses `.flow.ts` before HTTP. This is a backend limitation, not a lane failure. The former authored-agent 30-second deadline was already fixed in merged #243. Cloud has a separate one-hour runtime deadline, unchanged here.

Validation: SDK/type/test typechecks and build pass; the new cloud suite passes 22 tests. Existing CLI regression reruns remain red (latest 62/63, wrapper-preflight assertion; earlier runs also hit five-second test timeouts). No test gates or timeout limits were changed. The rebuilt-package check passes: both the installed CLI and exported SDK dispatch to a local HTTP contract server from a fresh temporary npm project. Dependency installation took six minutes on this host; this is not hosted execution or fresh-machine timing acceptance.

Commands and literal output are committed in `ops/runtime-evidence/ws14-cloud.txt`; the scoped credential probe is in `ops/runtime-evidence/ws14-cloud-auth.txt`. Raw test-output whitespace is retained verbatim in the transcript.

Three independent working-tree reviews covered Cloud contract correctness, security, and maintainability/architecture. Findings on routing, scope guidance, malformed status validation, token whitespace, compiled JSON, and stale package output were addressed. These are working-tree reviews, not exact-head merge approval. Veto tools were not exposed in this session.

Coordination: isolated branch/worktree; no shared-checkout changes. SDK coordination DMs were queued to `ws13-flows-local-ux`; only `cli.ts` (three additive lines) and `index.ts` (exports) overlap the shared SDK entry points. #243 is merged in this base; #244 remains open and changes ops/workflow files rather than these SDK paths. No authored-flow executor, kernel, verifier, or gate changes. Do not merge.
