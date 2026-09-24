# Cache authored CLI preflight per run (#561, F1)

Nine concurrent `f.llm` calls synchronously probed the same CLI nine times before worker-slot admission. Slow probes blocked the worker's event loop long enough for already-issued 30-second leases to expire. `WorkerSlots` admission is unchanged.

Reuse preflight's existing `(cli, source, model, execution)` cache across one authored run, for both LLM and agent calls. Read project configuration lazily once per runner. Keep the synchronous public preflight API and existing fail-closed resolution checks.

Auth/model readiness is now checked once per key per run, matching declarative execution. Auth changes during a run are detected by execution rather than another preflight; failed probes are cached too, so later calls receive the refusal instead of repeating a timeout. New runs probe again.

F2 (asynchronous probing) is deferred to [#574](https://github.com/AgentWorkforce/flows/issues/574). Distinct keys still require distinct synchronous probes. **One hung probe blocks for the model-readiness timeout: 60 s. That exceeds the 30 s lease and will still kill a concurrent step.** This focused fix does not establish the broader invariant that no synchronous probe runs while any lease is live.

Validation commands and literal captured output are in [evidence/561/README.md](evidence/561/README.md). Regression coverage uses a real kernel and slow fake CLI at capacity 1 and default capacity 4; it inspects every child journal, bounds session overlap, counts probes, checks failed-probe caching, agent parity, and fresh-run isolation. A separate test pins CLI/source/model cache keys.

Acceptance:

- [x] Nine concurrent fake-CLI calls at capacity 1 and default: success, one attempt per child, no `lease_expired`.
- [x] The issue's exact live-Claude repro succeeded locally at both capacities; journal outputs are 4 through 12. It could **not** be re-run at this head: `claude` is no longer authenticated in this environment (`"loggedIn": false`), captured in [live-one-recheck-unauthenticated.txt](evidence/561/live-one-recheck-unauthenticated.txt). That capture does show one 1.04 s probe followed by eight 0.01–0.12 s cached refusals.
- [ ] Restore `Promise.all` in prompt-lab: both requested files are absent from this checkout. No example restoration is claimed.
- [x] Mutation verification: removing the cache argument fails all five tests; restoring the committed bytes passes all five.

## The repository check, and one thing this branch fixes that it did not break

`.relayflow/check.sh` failed on this branch with `Tests 30 failed | 3194 passed`.
Each failure is now classified against `origin/main` (`e30226c`) by reverting
this branch's three source files, re-running, and restoring;
[.relayflow/repair-notes.md](.relayflow/repair-notes.md) carries the commands and
captured output. None came from #561. The classification:

* **`tests/artifact-gates.test.ts` (1) — `main` is red.** #566 made a declared
  `cwd` run-root-relative; #517 landed one commit later with a regression
  declaring an absolute `os.tmpdir()` `cwd`. Green apart, red together. Fixed
  here in a separate commit that moves the fixture inside the run root and
  changes no assertion — CI would fail it on this branch otherwise.
* **`tests/live-kernel.test.ts` (7) — environment.** `testdata/preflight`'s
  extensionless ESM agent-CLI fixtures load as CommonJS, silently producing no
  output, under this sandbox's `/home/daytona/package.json` (`"type":
  "commonjs"`). Handled in `check.sh`, uncommitted: CI never sees the ambiguity.
* **`tests/authored-node-runtime.test.ts` (whole suite) — missing setup.** Bun
  1.3.6 where every workflow pins 1.4.0. `check.sh` now installs it.
* **`tests/hosted-extension-{isolation,protocol}.test.ts` (22) — outside this
  container.** Unprivileged user namespaces are denied and the AppArmor
  restriction cannot be relaxed from inside, so `bwrap` cannot run even once
  installed. This is the provisioning step `check.sh` already documents as
  deliberately omitted.

With the first three addressed, the only outstanding failures in the whole check
are those 22. The steps `check.sh` never reached are captured in the repair notes
and pass.

Mutation command (from `packages/sdk`, before and after restore):

```sh
RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd npx vitest run tests/authored-probe-cache.test.ts
```

Re-run at this head as [mutation-red-rerun.txt](evidence/561/mutation-red-rerun.txt) and [mutation-green-rerun.txt](evidence/561/mutation-green-rerun.txt); the mutated run reproduces the issue's exact signature — `"completionReason":"lease_expired"` on attempt 1 with no heartbeat, `"disposition":"retry"`, attempt 2 `success`, and `WorkerLeaseLostError: Agent lease is already expired`. `packages/sdk/src/authored-worker-step.ts` hashes `b9cd463d9f1ee274175a0b659119262c0ba5b18f1afc11b866c3e0f7f34023b7` before the mutation and after the restore.

Captured failure summary (full [output](evidence/561/mutation-red.txt)):

```text
 Test Files  1 failed (1)
      Tests  5 failed (5)
```

Captured restored summary (full [output](evidence/561/mutation-green.txt)):

```text
 Test Files  1 passed (1)
      Tests  5 passed (5)
```

The mutation fails the journal assertion itself at both capacities, with `lease_expired` in the child journal. [Restore evidence](evidence/561/restore.txt) includes the literal clean diff result and identical SHA-256 hashes. No workflow files changed.
