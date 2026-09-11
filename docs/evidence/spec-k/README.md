# Slice K verification

Captured on 2026-09-11 in `flows-spec-K-memoization`, based on
`86a2ec20bf48353470526a170398fa49f269b8e4`.

Each transcript includes its literal command, working directory and complete
stdout/stderr. The final commands exited 0.

- [Kernel transcript](kernel.txt): 224 tests passed, zero failed.
- [SDK transcript](sdk.txt): 1066 tests passed, four skipped; includes source,
  public type, and test type checking and the built CLI against a live daemon.
- [Initial SDK transcript](sdk-initial.txt): 1066 passed, one failed, three
  skipped. The failure was the existing real-Claude analyzer readiness check.
  The final run uses that test's documented `RELAYFLOWS_ALLOW_ANALYZER_SKIP=1`
  non-gate option; this is not gate-2 acceptance evidence. The other three skips
  belong to the existing opt-in `real-cli-adapters.test.ts` suite.

The live `twenty-six-step` case first fails at step 26, edits that command,
then asserts `25 reused, 1 executed`. A durable marker remains at 25 writes.
A third run also asserts the JSON report has 26 reused and zero executed.
Kernel cases cover source immutability, restart after the source disappears,
changed actual inputs, source refusals, legacy and failed completion misses,
zero reuse budget and shared Rust/TypeScript canonical forms.

Local setup used `npm ci` in `packages/surface` and `packages/sdk`, then
`npm run build` in `packages/surface` and
`npm install --no-save --package-lock=false ../surface` in `packages/sdk`.
This links the checkout's surface types, because the published surface package
predates existing SDK API additions on the base branch. No dependency lockfile
was changed by this setup.

Review scope and protocol details: [STEP-MEMOIZATION.md](../../STEP-MEMOIZATION.md).
Follow-ups for the PR body: LSP reuse hints (L2), `flows replay` integration,
and named data gates (P).
