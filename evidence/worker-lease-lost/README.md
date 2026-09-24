# Worker lease refusal evidence

All commands run from the repository root unless the transcript starts with
`cd packages/sdk`. Each raw transcript includes the command and captured output.

The SDK tests inject stale dispatches and refusals; they do not claim to reproduce
the separate concurrent-dispatch root cause or to verify kernel lease expiry.
The live tests use the repository-built daemon and assert actual `step.completed`
and `run.completed` success entries before injecting completion/heartbeat refusals.

## Mutation checks

Run `python3 evidence/worker-lease-lost/mutate.py` from the repository root.
The script saves each source file as bytes, applies the exact change in
[mutations.txt](mutations.txt), captures failure, restores those bytes in a
`finally` block, checks byte equality, and captures the passing rerun.
The ledger includes SHA256 values for the restored source.

The fatal-policy check deliberately removes the retained fatal callback. It is
a negative-control mutation, not a claim that fatal behavior was newly added.
The terminal-only check removes terminal-refusal support separately from the
whole-filter reversion.

| Check | Command (in packages/sdk) | Mutated output | Restored output |
|---|---|---|---|
| filter | `npx vitest run tests/worker-lease-lost.test.ts` | [filter-mutant.txt](filter-mutant.txt) | [filter-restored.txt](filter-restored.txt) |
| terminal | `npx vitest run tests/worker-lease-lost.test.ts -t run_terminal` | [terminal-mutant.txt](terminal-mutant.txt) | [terminal-restored.txt](terminal-restored.txt) |
| fatal | `npx vitest run tests/worker-lease-lost.test.ts -t 'non-lease worker error'` | [fatal-mutant.txt](fatal-mutant.txt) | [fatal-restored.txt](fatal-restored.txt) |
| live | `npx vitest run tests/worker-lease-lost-live.test.ts` | [live-mutant.txt](live-mutant.txt) | [live-restored.txt](live-restored.txt) |
| sweep | `npx vitest run tests/worker-lease-sweep.test.ts` | [sweep-mutant.txt](sweep-mutant.txt) | [sweep-restored.txt](sweep-restored.txt) |
| direct | `npx vitest run tests/direct-run-worker-lease.test.ts` | [direct-mutant.txt](direct-mutant.txt) | [direct-restored.txt](direct-restored.txt) |
| resume | `npx vitest run tests/resume-worker-lease.test.ts` | [resume-mutant.txt](resume-mutant.txt) | [resume-restored.txt](resume-restored.txt) |

## Full checks

- [Final npm test](npm-test-final.txt): final source, Rust on PATH, explicit
  RELAYFLOWD_BIN pointing at this checkout's build. Full captured output.
- [New test typecheck](new-test-types.txt): `npm run typecheck:tests` from
  packages/sdk. That config enumerates its files by name rather than globbing,
  so every new regression file is listed in it; the gate covers them.
- [Sandbox probe](sandbox-probe.txt): direct OS isolation probe.

## Development transcripts

- [Initial npm test](npm-test-initial.txt): superseded development run, without
  RELAYFLOWD_BIN. This was started before the final test/source corrections;
  it includes interim CLI deadline and malformed-deadline failures.
  Use the final run for review.
- [Sweep before the fix](sweep-before.txt): reproduces immediate executor failure
  on an expired running snapshot.
- [First live completion check](live-first.txt): the two completion-refusal
  variants before adding the real-kernel heartbeat case. The restored live
  transcript above includes all three.

## Baseline comparison for the live-kernel suite

`python3 evidence/worker-lease-lost/baseline.py` replaces only the SDK source
files this change touches with their bytes at the **rebased parent**
(`git merge-base HEAD origin/main`; `BASE=<rev>` overrides), rebuilds, and
runs the unchanged live-kernel suite. It restores the implementation
byte-for-byte in `finally`, asserts equality, and rebuilds it. Each transcript
records the base it used.

Rerun after the rebase onto `2e2043f` (macOS, with `packages/sdk` built against
the workspace `@relayflows/surface`, as CI does):

- [Baseline build](baseline-build.txt): exit 0.
- [Baseline live-kernel](baseline-live-kernel.txt): `Tests 31 passed (31)` at
  base `2e2043f`.
- [Live-kernel at this head](live-kernel-head.txt): `Tests 31 passed (31)`.
- [Restored implementation build](restored-build.txt): exit 0.

The eight live-kernel failures the factory first reported came from its
sandbox, not from either revision. `/home/daytona/package.json` sits above the
checkout and declares `"type": "commonjs"`, which breaks
`testdata/preflight`'s extensionless ESM fixtures. On a clean machine the
suite passes before and after this change.
