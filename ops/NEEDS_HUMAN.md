# NEEDS_HUMAN — multiple blockers

## Current blocker (2026-09-12, run afcc2c6f) — SDK compilation errors

**Assessment:** Gate 3 hn-monitor-runner work is BLOCKED on SDK compilation errors.

The gate 3 target (ops/TARGET.md) requires implementing `sdk/src/hn-monitor-runner.ts` with comprehensive test coverage. The definition of done includes "`cd packages/sdk && npm test` green (pretest hook builds the kernel automatically)".

**The block:** The SDK does not compile. TypeScript errors prevent npm test from running:

```
src/authored-worker-step.ts(118,80): error TS2339: Property 'cwd' does not exist on type 'AgentOptions'.
src/cli/check-triggers.ts(23,19): error TS2339: Property 'handlers' does not exist on type 'AuthoredFlowDefinition<unknown>'.
src/helper-preflight.ts(1,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/helper-writeback.ts(5,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperClients'.
src/preflight.ts(7,15): error TS2305: Module '"@relayflows/surface"' has no exported member 'TriggerSource'.
src/slack-preflight.ts(3,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/slack-writeback.ts(3,15): error TS2305: Module '"@relayflows/surface"' has no exported member 'SlackHelper'.
src/trigger-executor.ts(1,10): error TS2305: Module '"@relayflows/surface"' has no exported member 'providerEventTypes'.
```

These errors indicate missing or incompatible dependencies from the `@relayflows/surface` package.

**Question for human:** Should the Lead fix the SDK compilation errors first (which appears out of scope for the gate 3 hn-monitor-runner target), or is there an environment/dependency issue that needs resolution before this work can proceed?

**Options:**
- **A:** Fix the SDK compilation errors first. This would be out-of-scope work (SDK package dependencies, not the runner itself), but it unblocks the target.
- **B:** Wait for human intervention to resolve the SDK compilation environment, since fixing package dependencies is outside the gate 3 scope defined in TARGET.md.
- **C:** Something else (e.g., the compilation errors are expected in this environment and there's a different test command to use).

---

## Prior blocker (2026-09-08) — gate 3 launches; the block moved to Daytona capacity

## Status (2026-09-08 ~04:00Z) — supersedes the 2026-09-07 assessment below

**The secret is stored and it works. Do not act on the old ask.**

`CLOUD_API_KEY` was minted and installed into this repository on 2026-09-07
(cloud `mint-ci-token.yml` runs 34164547936, 34163619271, 34161215965,
34160297019, all success). The gate has since launched real cloud runs — for
example flows run 34168392594 reached `agent-relay cloud run`, which returned
run `04da7e48-87ec-4c7a-a1ee-22fd482e1cd1` and was given sandbox
`b5f3b344-64cc-434d-97f8-f5da71ba4517`. It executed for roughly five minutes.

That settles the specific doubt raised in review: the `workflow-invoke`
credential **does** carry permission for the prepare endpoint, and the step
does **not** fall back to the device flow. Storing the secret cleared the block
it was supposed to clear.

**The current block is Daytona CPU quota, and it is a different ask.** The run
above failed with, verbatim from its `result.error`:

    Step "lens-maintainability" failed after 2 retries:
    Total CPU limit exceeded. Maximum allowed: 250.

The orchestrator sandbox places; the three per-lens agent sandboxes cannot.
Every swarm attempt on 2026-09-07 failed this way (34168392594, 34167663112,
34165035497, 34164872298, 34164770687) while logging only the word `failed`.

**What a human is needed for now:** run cloud's `daytona-sweep-orphans.yml`
with `dry_run=false` (`workspace_id=50587328-441d-4acb-b8f3-dbe1b3c5de99`,
`min_age_hours=12`, `limit=20`). Dry runs report 79 eligible orphans, oldest
41.6h, ~40 CPU reclaimed per invocation. It is destructive, so no agent has run
it.

**What remains unverified.** The launch and authentication path is proven; the
verdict path is not. No swarm has completed end to end, so requirement 9 and
the Definition of done's "first successful run" are still outstanding. Calling
gate 3 COMPLETE was premature — AGENTS.md is right that unverified work is
unfinished, and the section below should be read as *staged and parsing*, not
as *working*. It becomes complete when a swarm returns a verdict.

**Everything below this line is the 2026-09-07 record and is superseded.**
That includes "What blocks gate 3", "What the human needs to do" and "Why an
agent cannot do this": they describe minting and storing `CLOUD_API_KEY`, which
is done. Do not follow those steps. The only live ask is the orphan sweep named
above.

---

## Assessment (2026-09-07, run bc76617d) — SUPERSEDED, kept for history

Gate 3 (cloud review-swarm redesign) implementation is **COMPLETE**. All 9 architectural requirements from the TARGET scope are satisfied. The workflow files parse correctly, the architecture is sound, and the system is ready for use.

**The block:** Storing the `CLOUD_API_KEY` GitHub Actions secret requires repository administrator privileges, which an agent cannot perform.

## Evidence the implementation is complete

All TARGET.md requirements verified:

### Files exist and parse:
```
python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))"
✓ workflows/review-swarm.yaml parses

python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))"
✓ .github/workflows/review-swarm.yml parses

bash -n .github/workflows/scripts/swarm-prepare.sh
✓ .github/workflows/scripts/swarm-prepare.sh

bash -n .github/workflows/scripts/swarm-post.sh
✓ .github/workflows/scripts/swarm-post.sh

bash -n .github/workflows/scripts/swarm-verdict.sh
✓ .github/workflows/scripts/swarm-verdict.sh
```

### All 9 architectural requirements satisfied:

1. **Immutable gate** ✓ — Two checkout steps (.github/workflows/review-swarm.yml:32-48): pr-head from PR, gate-files from main. Swarm launches using gate-files path.

2. **Unified verdict logic** ✓ — swarm-verdict.sh is the single source of truth, sourced by both workflows/review-swarm.yaml:132 and swarm-post.sh:8. Zero duplication.

3. **Auth secret validation fail-fast** ✓ — Preflight step (.github/workflows/review-swarm.yml:54-58) validates CLOUD_API_URL and CLOUD_API_KEY before launch.

4. **Sticky marker + sticky transcripts** ✓ — HTML anchors (`<!-- review-swarm -->` and `<!-- swarm-lens: <lens> -->`), upsert_comment function finds and PATCHes existing.

5. **Every PR gets reviewed** ✓ — No author whitelist. Trigger unconditional (line 4-5).

6. **Cloud sandbox has no gh auth** ✓ — swarm-prepare.sh fetches on GHA runner, stages into .review-target/, uses git add -f. .gitignore does NOT mask .review-target (verified).

7. **Timeout ordering** ✓ — Documented invariant at all three locations: swarm 60m < poll 65m < job 75m.

8. **Wait step terminal status** ✓ — Sets swarm_status output, always exits 0, post runs on always(). Enforce step checks status != completed.

9. **Transcript freshness** ✓ — .review-target/run-start marker, freshness check in swarm-verdict.sh:33, STALE verdict fails.

### Additional requirements:
- README.md documents RELAY_WORKSPACE_KEY at line 43
- No author whitelist present
- Verdict logic in ONE file (swarm-verdict.sh)

## What blocks gate 3

The workflow file ALREADY references the secret:
```
.github/workflows/review-swarm.yml:28:
      CLOUD_API_KEY: ${{ secrets.CLOUD_API_KEY }}
```

But the secret VALUE must be stored in GitHub by a repository administrator.

## What the human needs to do

1. **Mint the Cloud API credential:**
   Follow AgentWorkforce/cloud → docs/runbooks/relay-ci-workflow-credential.md
   Profile: `workflow-invoke`
   Scope: `workflow:invoke:read` and `workflow:invoke:write`

2. **Store as GitHub Actions secret:**
   Repository Settings → Secrets and variables → Actions → New repository secret
   Name: `CLOUD_API_KEY`
   Value: (the minted credential from step 1)

3. **Verify it works:**
   Open any PR (or push to an existing PR branch)
   Check `.github/workflows/review-swarm.yml` runs
   The `Launch cloud swarm` step should succeed (not fall back to device flow)

## Why an agent cannot do this

1. Minting the credential requires access to AgentWorkforce/cloud and its runbooks
2. Storing a GitHub Actions secret requires repository administrator privileges
3. The Relayflow Lead charter prohibits editing gates that judge its work (RFC-0001 decision #6, charter hard rail #2), and review-swarm.yml IS such a gate

## Definition of done

Gate 3 will be COMPLETE (not just blocked) when:
1. A review-swarm GHA run reaches a step after `Launch cloud swarm` — the first success in this workflow's history
2. The run ID from `Launch cloud swarm` appears in a PR comment
3. Three lens transcripts are posted to the PR

Currently: secret storage is DONE (2026-09-07 21:50Z) and the launch path is
proven — a run reaches `agent-relay cloud run` and is given a sandbox. None of
the three conditions above is met yet: no swarm has returned a verdict, so
gate 3 is not complete. What stops it now is Daytona CPU quota, not a secret.
