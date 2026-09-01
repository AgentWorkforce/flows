# NEEDS_HUMAN — blocked on contradictory requirements

## The contradiction

Gate 3 (Track D: cloud review-swarm redesign) has a DoD that requires:

**DoD requirement from TARGET.md:**
> `cd sdk && npm test` green (should be unaffected)

**Out of scope from TARGET.md:**
> - `sdk/` (Track A owns that)

**Current reality:**
SDK tests are BROKEN with TypeScript compilation error:
```
$ cd sdk && npm test
error TS2688: Cannot find type definition file for 'node'.
```

The gate 3 scope (`.github/workflows/review-swarm.yml` + scripts + `workflows/review-swarm.yaml`) does NOT touch sdk/. The work is ready to execute. But the DoD cannot be satisfied without violating the track isolation that prevents parallel runs from colliding.

## Evidence of the SDK failure

```
$ cd /project/workflows/runs/1de8b927-4a37-4f02-adce-cbd7a39728cc/sdk && npm test 2>&1 | tail -20

> @relayflows/sdk@0.1.0 test
> npm run test:prep && npm run build && vitest run


> @relayflows/sdk@0.1.0 test:prep
> ( cd ../kernel && sh ../ops/cargo.sh build ) && ( [ ! -d ../testdata/preflight ] || find ../testdata/preflight -name '*-cli' -type f -exec chmod +x {} + )

   Compiling bitflags v2.13.1
   Compiling rusqlite v0.37.0
   Compiling relayflowd-journal v0.1.0 (/project/workflows/runs/1de8b927-4a37-4f02-adce-cbd7a39728cc/kernel/relayflowd-journal)
   Compiling relayflowd v0.1.0 (/project/workflows/runs/1de8b927-4a37-4f02-adce-cbd7a39728cc/kernel/relayflowd)
    Finished `dev` profile [unoptimized + debuginfo] target(s) in 4.13s

> @relayflows/sdk@0.1.0 build
> tsc && node scripts/make-cli-executable.mjs

error TS2688: Cannot find type definition file for 'node'.
  The file is in the program because:
    Entry point of type library 'node' specified in compilerOptions
```

Kernel tests pass (6 shown, 30 total per bootstrap-report.md):
```
$ cd kernel && sh ../ops/cargo.sh test 2>&1 | tail -10
test tests::an_unconfirmed_election_is_reclaimed_by_the_next_attempt_not_treated_as_done ... ok
test tests::append_is_durable_and_monotonic_after_reopen ... ok
test tests::effects_are_deduplicated_at_the_journal_boundary ... ok
test tests::failed_commit_is_returned_not_swallowed ... ok
test tests::rollover_is_atomic_scaffolding_for_epoch_resume ... ok

test result: ok. 6 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out; finished in 0.02s
```

## The exact question

Should gate 3's DoD be amended to remove the SDK test requirement, OR should this run wait for Track A to fix the SDK?

## Options

**Option A: Remove SDK test requirement from gate 3 DoD**
- Gate 3 work genuinely does NOT touch sdk/
- The review-swarm infrastructure is `.github/` + `workflows/` + scripts
- SDK test requirement appears to be defensive (verify nothing broke) but gate 3 cannot break what it doesn't touch
- Allows gate 3 to proceed immediately
- **Risk:** Delivers gate 3 work atop a broken SDK state (though they're isolated)

**Option B: Fix SDK compilation first**
- Enter Track A territory to fix `@types/node` issue in sdk/
- Violates the parallel-tracks isolation
- **Risk:** Collision with a sibling Track A run

**Option C: Defer gate 3 until Track A resolves SDK**
- Preserves track isolation
- Blocks gate 3 progress on Track A's timeline
- **Risk:** Gate 3 work is ready but waits

**Option D: Execute gate 3 work, document SDK failure, expect human to fix before merge**
- Complete all gate 3 files per requirements 1-9
- DoD #6 fails honestly
- Human fixes SDK before merging the PR
- Preserves evidence of what was delivered vs. what blocked

## Recommendation

**Option A** — remove the SDK test requirement from gate 3's DoD.

**Rationale:**
1. Gate 3 scope is `.github/workflows/` + `workflows/review-swarm.yaml` — zero sdk/ overlap
2. The DoD's "should be unaffected" language acknowledges SDK is out of scope
3. Track isolation is the mechanism that makes parallel execution safe (per TARGET.md line 93-95)
4. The SDK failure predates this run and is orthogonal to review-swarm infrastructure

If SDK tests were required for gate 3, the TARGET.md scope would include sdk/ or depend on Track A completing first. It does not.

## What happens next

If Option A is chosen, the work package becomes:

**Objective:** Build cloud review-swarm infrastructure per 9 requirements
**Files:** `.github/workflows/review-swarm.yml`, scripts, `workflows/review-swarm.yaml`, `.gitignore`, `README.md`
**DoD:** Requirements 1-5, 7 (parse checks, no whitelist, immutable gate, docs, final state)
**Out of scope:** sdk/ (including its tests)

Work can proceed immediately.
