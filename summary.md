# Cache authored CLI preflight per run (#561, F1)

Nine concurrent `f.llm` calls synchronously probed the same CLI nine times before worker-slot admission. Slow probes blocked the worker's event loop long enough for already-issued 30-second leases to expire. `WorkerSlots` admission is unchanged.

Reuse preflight's existing `(cli, source, model, execution)` cache across one authored run, for both LLM and agent calls. Read project configuration lazily once per runner. Keep the synchronous public preflight API and existing fail-closed resolution checks.

Auth/model readiness is now checked once per key per run, matching declarative execution. Auth changes during a run are detected by execution rather than another preflight; failed probes are cached too, so later calls receive the refusal instead of repeating a timeout. New runs probe again.

F2 (asynchronous probing) is deferred to [#574](https://github.com/AgentWorkforce/flows/issues/574). Distinct keys still require distinct synchronous probes. **One hung probe blocks for the model-readiness timeout: 60 s. That exceeds the 30 s lease and will still kill a concurrent step.** This focused fix does not establish the broader invariant that no synchronous probe runs while any lease is live.

Validation commands and literal captured output are in [evidence/561/README.md](evidence/561/README.md). Regression coverage uses a real kernel and slow fake CLI at capacity 1 and default capacity 4; it inspects every child journal, bounds session overlap, counts probes, checks failed-probe caching, agent parity, and fresh-run isolation. A separate test pins CLI/source/model cache keys.

Acceptance:

- [x] Nine concurrent fake-CLI calls at capacity 1 and default: success, one attempt per child, no `lease_expired`.
- [x] The issue's exact live-Claude repro succeeds locally at both capacities; journal outputs are 4 through 12.
- [ ] Restore `Promise.all` in prompt-lab: both requested files are absent from this checkout. No example restoration is claimed.
- [x] Mutation verification: removing the cache argument fails all five tests; restoring the committed bytes passes all five.

The full SDK suite is **not green**. `npm test` captured:

```text
 Test Files  9 failed | 186 passed | 3 skipped (198)
      Tests  42 failed | 3174 passed | 26 skipped (3242)
     Errors  2 errors
```

The full output is [sdk-suite.txt](evidence/561/sdk-suite.txt). Failures include unavailable bubblewrap, Bun 1.3.6 versus required 1.4.0, missing default kernel paths, and existing worker/gate expectations. These failures were not fixed or fully baseline-classified in this focused change. The kernel suite's complete command/output is [documented separately](evidence/561/README.md#broader-checks).

Mutation command (from `packages/sdk`, before and after restore):

```sh
RELAYFLOWD_BIN=/home/daytona/.relayflows-toolchain/target/2962130851/debug/relayflowd npx vitest run tests/authored-probe-cache.test.ts
```

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
