`runInCloud` and `flows run --cloud` implement declarative submission to Cloud’s existing v2 API plus cancellable observation. The CLI reports acceptance and optionally waits with `--wait`; it starts no local daemon and requires no node enrollment. Cancelling observation does not cancel the hosted run.

**Scope settled by Khaliq’s 2026-09-08 ruling:**

- **Built:** SDK submission/observation and the thin CLI for authoring YAML/JSON and compiled kernel JSON.
- **Deliberately design-only:** gallery / `publishFlowRun`. Publishing requires a new endpoint in the Cloud repository, outside this lane, with no assigned owner. The written design in `docs/CLOUD-PUBLICATION-DESIGN.md` is the deliverable. No endpoint, export, gallery, or public URL was invented; implementation is not an acceptance dependency.
- **Cancelled, not deferred:** the landing page. No page will be built or deployed, and there is no target to wait for. Proposed deterministic gates + session replay + BYO CLI harness copy remains only as documentation in `docs/CLOUD.md`.
- **Live hosted proof: BLOCKED-ON-CREDENTIAL.** Exact captured result: `Authenticated Cloud-base-path read HTTP: 401`. No hosted success is claimed. This credential block does not hold review readiness under Khaliq’s ruling.

The client reuses the existing compiler, preserves the production `/cloud` base path, validates IDs/statuses and terminal completion reasons, retries transient GET observation failures with capped backoff, rejects credential-bearing redirects and Relay workspace/observer keys, and bounds individual HTTP requests without imposing a run deadline. Submission is not automatically retried because the API has no client idempotency guarantee.

Cloud’s current v2 bootstrap rejects authored TypeScript; the SDK refuses `.flow.ts` before HTTP. Cloud retains its separate one-hour execution deadline. No authored-flow executor, kernel, verifier, or gate changes are included.

Review fixes in `d1ef3ae`: distinguish unknown admission from interrupted observation; retry only transient GET failures; classify local input and pre-admission HTTP 401/403 as exit 2; require HTTPS; validate terminal completion reasons; use the central CLI parser; correct design-only cache/schema notes and evidence claims.

Current verification (including the response-body AbortError correction): **63 CLI + 46 cloud tests = 109 passed**, both typechecks and the build passed. The rebuilt packed CLI/SDK proof at `d1ef3ae` passed over local HTTPS with certificate verification enabled. This is contract/packaging evidence, not hosted execution. The earlier wrapper assertion did not reproduce on either baseline `f0a3b3b` (63/63) or current source (63/63); its cause remains unconfirmed. The old failures are retained, not relabeled as passing. No pre-existing tests, gates, or timeout limits were modified; the PR adds cloud regression tests.

Captured current test command/output:

```text
$ node node_modules/vitest/vitest.mjs run tests/cli.test.ts tests/cloud-run.test.ts --maxWorkers=1 --minWorkers=1

 RUN  v2.1.9 /Users/khaliqgant/Projects/AgentWorkforce/.worktrees/ws14-flows-cloud/packages/sdk

 ✓ tests/cli.test.ts (63 tests) 27538ms
   ✓ flows check CLI > binds a checked relative wrapper to the flow directory for worker execution 544ms
   ✓ flows check CLI > uses the raw Claude adapter model flag instead of accepting auth status as model proof 384ms
   ✓ flows check CLI > uses Codex login status and reports a rejected model as unavailable, not unauthenticated 4264ms
   ✓ flows check CLI > refuses a nonconforming custom wrapper without calling it an authentication failure 409ms
   ✓ flows check CLI > accepts an exact allowlisted named-agent model and probes that model 2281ms
   ✓ flows check CLI > checks the same named-agent contract from declarative JSON 7988ms
   ✓ flows check CLI > distinguishes an allowlisted but inaccessible model from broken auth 342ms
   ✓ flows check CLI > passes all three canonical ladder flows and prints their resolved CLI 373ms
   ✓ flows check CLI > refuses ladder flow hello-agent with cli_unresolved under an induced fault 330ms
   ✓ flows check CLI > resolves a project CLI path relative to the flows.json that declares it 904ms
   ✓ flows check CLI > maps every input refusal path to its declared kind without raw exceptions 1433ms
   ✓ flows run/resume CLI over the journal protocol > parses run options, submits the kernel dialect, and exits 0 on success 2923ms
   ✓ flows run/resume CLI over the journal protocol > exits 3 and names the parked llm step 850ms
   ✓ flows run/resume CLI over the journal protocol > follows a dispatched worker step instead of reporting a protocol error 1067ms
 ✓ tests/cloud-run.test.ts (46 tests) 651ms

 Test Files  2 passed (2)
      Tests  109 passed (109)
   Start at  22:16:05
   Duration  43.24s (transform 1.33s, setup 0ms, collect 10.08s, tests 28.19s, environment 0ms, prepare 1.82s)

EXIT CODE: 0
```

The complete current commands/output (baseline, source comparison, both typechecks, CLI/cloud suites, rebuild/pack/install and HTTPS dispatch) are in [ws14-review-fixes.txt](../runtime-evidence/ws14-review-fixes.txt). [Review thread dispositions and swarm responses](ws14-review-responses.md) explain fixes and scope decisions.

Commands and literal captured output are committed in [ws14-cloud.txt](../runtime-evidence/ws14-cloud.txt); the credential probe and HTTP 401 are in [ws14-cloud-auth.txt](../runtime-evidence/ws14-cloud-auth.txt). The baseline comparison is captured in [ws14-wrapper-baseline.txt](../runtime-evidence/ws14-wrapper-baseline.txt). Raw test-output whitespace is retained verbatim.

Work is isolated on `feat/flows-run-in-cloud`; shared SDK entry-point changes integrate cloud mode with the central parser. **Ready for review; do not merge.**
