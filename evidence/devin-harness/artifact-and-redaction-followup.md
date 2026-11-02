# Artifact CI and overlapping probe redactions

The [artifact job at a046f280](https://github.com/AgentWorkforce/flows/actions/runs/41524171476/job/125547526284) failed on two issue-swarm calls without explicit models.
The example now pins each supported broker/skills CLI pair explicitly (Claude,
Codex, Cursor), refusing other selections before effects. No CI gate, scanner,
or waiver was changed.

Probe redaction preserves shared known-value/header/cookie/environment-dump
handling first. It then collects supplemental email/token/hex matches and short
Devin credential matches against that same redacted text, masking the union of
overlapping spans. This covers a short key inside a shape, a shape inside a short
key, and overlapping occurrences of a short key. Regression tests cover both
synchronous and asynchronous drivers and preserve other providers' known-secret
handling. There are no changes to the shared transcript redactor.

The model-pin test now reaches the pre-existing dynamic call in land.flow.ts.
Its failure is captured below; this report does not claim green CI. The land
owner has been notified.

## SDK focused regressions and types

Working directory: `packages/sdk`.

```sh
set -o pipefail; { TMPDIR=/Users/khaliqgant/.cache/devin-harness node node_modules/vitest/vitest.mjs run tests/devin.test.ts tests/cli-probe.test.ts tests/preflight.test.ts tests/agent-transcript.test.ts && npm run typecheck && npm run typecheck:tests; } 2>&1 | tee /Users/khaliqgant/.cache/devin-harness/overlap-followup-final.log
```

```text

 RUN  v2.1.9 /Volumes/T7/Projects/AgentWorkforce/worktrees/flows/devin-harness-20261102/packages/sdk

 ✓ tests/agent-transcript.test.ts (29 tests) 141ms
 ✓ tests/preflight.test.ts (70 tests) 42ms
 ✓ tests/devin.test.ts (25 tests) 6255ms
   ✓ launches print mode with file input and cleans up after --version
Do the task 326ms
   ✓ checks provider auth with isolated credentials in both synchronous and asynchronous preflight 408ms
   ✓ refuses an unavailable model and missing model-probe credentials in both preflight drivers 612ms
   ✓ fully redacts echoed credentials alongside shape-based scrubbing 325ms
   ✓ redacts the complete overlap between credentials and diagnostic shapes: abc 438ms
   ✓ redacts the complete overlap between credentials and diagnostic shapes: abc 315ms
   ✓ redacts the complete overlap between credentials and diagnostic shapes: abc 313ms
   ✓ redacts the complete overlap between credentials and diagnostic shapes: a@b.co! 409ms
   ✓ redacts the complete overlap between credentials and diagnostic shapes: aba 362ms
   ✓ preserves shared redaction before short-key and supplemental rules: Authorization: Bearer abcSECRET_SUFFIX123456 494ms
   ✓ preserves shared redaction before short-key and supplemental rules: Cookie: session=abcSECRET_SUFFIX123456 512ms
 ✓ tests/cli-probe.test.ts (19 tests) 7214ms
   ✓ redacts whole non-Devin secrets and enclosing shapes: prefix-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-secretSuffix 409ms
   ✓ executes a canonical shebang target through its authored alias in both probe drivers 380ms
   ✓ keeps synchronous and asynchronous classification equal: success 457ms
   ✓ keeps synchronous and asynchronous classification equal: auth denied 329ms
   ✓ keeps missing executables and unsupported identification fail closed 335ms
   ✓ scopes delivered secrets in PATH lookup and provider probes for checked and authored steps 986ms
   ✓ reports timeout in both drivers while the async driver leaves the loop free 791ms
   ✓ reports signal termination in both drivers 320ms
   ✓ classifies a failed claude model probe from its own output: outdated CLI 448ms
   ✓ classifies a failed claude model probe from its own output: usage limit 456ms
   ✓ classifies a failed claude model probe from its own output: unknown model 376ms
   ✓ classifies a failed claude model probe from its own output: unrecognised output 419ms

 Test Files  4 passed (4)
      Tests  143 passed (143)
   Start at  13:43:03
   Duration  8.54s (transform 1.09s, setup 49ms, collect 2.97s, tests 13.65s, environment 0ms, prepare 217ms)


> @relayflows/sdk@2.0.55 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json


> @relayflows/sdk@2.0.55 typecheck:tests
> tsc -p tsconfig.tests.json

```

## Issue-swarm model selection and saved-source behavior

Working directory: `examples/issue-swarm`.

```sh
set -o pipefail; { TMPDIR=/Users/khaliqgant/.cache/devin-harness npm run typecheck && TMPDIR=/Users/khaliqgant/.cache/devin-harness npm test; } 2>&1 | tee /Users/khaliqgant/.cache/devin-harness/issue-swarm-pins-final.log
```

```text

> typecheck
> tsc -p tsconfig.json


> test
> node --experimental-strip-types --test tests/*.test.ts

✔ count bounds parallel issues; three broker reviewers per PR; releases before removing worktrees (3.38375ms)
✔ each selectable CLI pins its model for implementers and reviewers (1.598542ms)
✔ unsupported CLI selections fail before commands or sessions start (0.347334ms)
✔ NO-GO findings go to the same implementer, followed by fresh review (0.66925ms)
✔ monitor sends CI and review-thread repairs, then captures fresh state (1.268083ms)
✔ pending checks and unknown mergeability wait without repair pushes (0.472875ms)
✔ a completed clean snapshot takes precedence over deadline expiry (0.169417ms)
✔ monitor fixes that push a new head trigger all three reviewers again (0.216083ms)
✔ a timed out message ends with human attention and releases its implementer (0.446584ms)
✔ a new head cannot inherit GO after the last review pass (0.272959ms)
✔ review exhaustion and unknown mergeability cannot become success at deadline (0.196083ms)
✔ zero monitor budget captures status but sends no monitor repair (0.10475ms)
✔ a failed lane waits for peers and still releases each returned session (0.610709ms)
✔ worktree creation failure still cleans up the successful sibling lane (0.324125ms)
✔ malformed reviewer result releases implementers and cannot produce GO (0.173375ms)
✔ release failures preserve that worktree and do not skip other cleanup (1.212292ms)
✔ dirty worktree is preserved and cleanup error reported (0.485083ms)
✔ empty issue list allocates no agents or worktrees (0.217208ms)
✔ title-only issues normalize null body without losing their identity (0.134667ms)
✔ invalid input fails before effects; label shell metacharacters stay quoted (0.240167ms)
✔ explicit foreign repo and a mismatched origin fail before allocating worktrees (0.225375ms)
✔ malformed, stale and contradictory verdicts fail closed (0.504833ms)
✔ captures current-head checks, newest status and final metadata read (1.212458ms)
✔ pages REST checks and GraphQL unresolved threads (1.2305ms)
✔ a later approval clears a changes-requested review but a comment does not (0.482708ms)
✔ rejects changing heads and incomplete GraphQL responses (0.763042ms)
✔ pending, stale checks, unknown mergeability, blocked state and stale review fail closed (0.26075ms)
✔ GraphQL repeated cursors and REST pagination exhaustion fail closed (0.855292ms)
✔ saved source runs with fakes after copying without sibling modules (21.3055ms)
ℹ tests 29
ℹ suites 0
ℹ pass 29
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 158.819208
```

## Remaining model-pin failure

Working directory: `packages/sdk`.

```sh
set -o pipefail; TMPDIR=/Users/khaliqgant/.cache/devin-harness node node_modules/vitest/vitest.mjs run tests/shipped-source-models.test.ts 2>&1 | tee /Users/khaliqgant/.cache/devin-harness/shipped-source-pins.log
```

```text

 RUN  v2.1.9 /Volumes/T7/Projects/AgentWorkforce/worktrees/flows/devin-harness-20261102/packages/sdk

 ❯ tests/shipped-source-models.test.ts (2 tests | 1 failed) 157829ms
   × first-party shipped source model pins > gives every TypeScript agent and LLM an explicit supported pair or a pinned named-agent declaration 157789ms
     → examples/land/land.flow.ts: omitted pairs must resolve call-exactly through complete named agents: expected [ Array(1) ] to deeply equal []

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯

 FAIL  tests/shipped-source-models.test.ts > first-party shipped source model pins > gives every TypeScript agent and LLM an explicit supported pair or a pinned named-agent declaration
AssertionError: examples/land/land.flow.ts: omitted pairs must resolve call-exactly through complete named agents: expected [ Array(1) ] to deeply equal []

- Expected
+ Received

- Array []
+ Array [
+   "examples/land/land.flow.ts:557 has unprovable options overrides",
+ ]

 ❯ tests/shipped-source-models.test.ts:100:112
     98|         seenDynamicWaivers.add(name);
     99|       }
    100|       expect(result.missing, `${name}: omitted pairs must resolve call…
       |                                                                                                                ^
    101|     }
    102|     expect(seenDynamicWaivers).toEqual(new Set(DYNAMIC_PAIR_SOURCE_WAI…

⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯[1/1]⎯

 Test Files  1 failed (1)
      Tests  1 failed | 1 passed (2)
   Start at  13:37:13
   Duration  158.34s (transform 111ms, setup 9ms, collect 316ms, tests 157.83s, environment 0ms, prepare 28ms)

```

## Bounded diagnostic coverage follow-up

The span arrays/sort above are replaced by a single byte mask over the
shared-redacted text. Shape matches and short-key occurrences mark covered
characters; connected marked runs are emitted once with credential marker
precedence. Auxiliary coverage storage is one byte per diagnostic character,
independent of how many matches it contains. Shared redaction remains first.
An email-start boundary prevents retrying the email matcher inside every suffix
of a long word.

The fixture writes the full 900,000-character diagnostic synchronously before
exiting, so both probe drivers receive it completely. The assertion includes the
credential-file echo after that diagnostic, protecting against a truncated fixture.
No gates, waivers, or land source were modified.

Working directory: packages/sdk.

```sh
set -o pipefail; { TMPDIR=/Users/khaliqgant/.cache/devin-harness node node_modules/vitest/vitest.mjs run tests/devin.test.ts tests/cli-probe.test.ts tests/preflight.test.ts tests/agent-transcript.test.ts && npm run typecheck && npm run typecheck:tests; } 2>&1 | tee /Users/khaliqgant/.cache/devin-harness/bounded-redaction-final.log
```

```text

 RUN  v2.1.9 /Volumes/T7/Projects/AgentWorkforce/worktrees/flows/devin-harness-20261102/packages/sdk

 ✓ tests/agent-transcript.test.ts (29 tests) 153ms
 ✓ tests/preflight.test.ts (70 tests) 48ms
 ✓ tests/devin.test.ts (26 tests) 5637ms
   ✓ redacts a near-buffer-size response to a one-character credential without retaining per-match spans 416ms
   ✓ checks provider auth with isolated credentials in both synchronous and asynchronous preflight 411ms
   ✓ refuses an unavailable model and missing model-probe credentials in both preflight drivers 583ms
   ✓ fully redacts echoed credentials alongside shape-based scrubbing 315ms
   ✓ redacts the complete overlap between credentials and diagnostic shapes: abc 362ms
   ✓ redacts the complete overlap between credentials and diagnostic shapes: aba 507ms
 ✓ tests/cli-probe.test.ts (19 tests) 5979ms
   ✓ returns the absolute executable selected for a bare CLI name 339ms
   ✓ keeps synchronous and asynchronous classification equal: model denied 439ms
   ✓ scopes delivered secrets in PATH lookup and provider probes for checked and authored steps 935ms
   ✓ reports timeout in both drivers while the async driver leaves the loop free 449ms
   ✓ reports signal termination in both drivers 532ms
   ✓ classifies a failed claude model probe from its own output: unrecognised output 377ms

 Test Files  4 passed (4)
      Tests  144 passed (144)
   Start at  13:52:47
   Duration  7.26s (transform 1.09s, setup 44ms, collect 2.86s, tests 11.82s, environment 0ms, prepare 200ms)


> @relayflows/sdk@2.0.55 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json


> @relayflows/sdk@2.0.55 typecheck:tests
> tsc -p tsconfig.tests.json

```
