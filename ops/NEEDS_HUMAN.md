# NEEDS HUMAN — gate 3 scope vs DoD conflict

## The question

Gate 3's review-swarm implementation is architecturally complete: all 9 non-negotiable requirements from TARGET.md (immutable gate, unified verdict logic, auth preflight, sticky transcripts, no author whitelist, GHA-side fetch, timeout ordering, always() post step, freshness binding) are satisfied in the current tree.

All gate 3 files parse correctly:
- `workflows/review-swarm.yaml` parses
- `.github/workflows/review-swarm.yml` parses
- All three shell scripts parse (`swarm-prepare.sh`, `swarm-post.sh`, `swarm-verdict.sh`)

**However:** TARGET.md's DoD (line 81) requires `cd sdk && npm test` green, but the SDK build fails with:

```
error TS2688: Cannot find type definition file for 'node'.
```

This is an sdk/ build issue (missing `@types/node` devDependency), which is Track A's scope per TARGET.md line 86: "sdk/ (Track A owns that)".

## The conflict

- TARGET.md line 86 explicitly excludes sdk/ from gate 3 scope
- TARGET.md line 81 requires `cd sdk && npm test` green as DoD
- These contradict

## Options

**A. Declare gate 3 complete based on its own scope**
All 9 architectural requirements satisfied, all gate 3 files parse. Treat SDK tests as a Track A cross-track dependency that must be fixed separately before any PR can merge (since verify presumably runs SDK tests).

**B. Fix the SDK build as a gate 3 blocker**
Install `@types/node` in sdk/package.json devDependencies to unblock the DoD, treating it as a necessary dependency even though it's Track A territory.

**C. Adjust the DoD**
Remove the `cd sdk && npm test` requirement from gate 3's DoD, or replace it with "SDK tests pass OR sdk/ changes are out of scope for this run".

## Recommendation

Option B (fix the SDK build) is fastest: adding `@types/node` is a one-line package.json change that unblocks both gate 3 verification and any other work that depends on SDK tests passing. It's technically out of scope, but it's also non-controversial and unblocks everything.

However, this decision is the operator's: should a gate 3 run fix Track A dependencies, or should it report done-except-for-Track-A and let Track A own the fix?

## Current status

Gate 3 implementation: COMPLETE per all architectural requirements.
Gate 3 DoD verification: BLOCKED on Track A sdk/ build.
