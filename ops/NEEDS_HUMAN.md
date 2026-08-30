# NEEDS_HUMAN — Blocked on human decision

**Date:** 2026-08-30
**Gate:** 3 (review-swarm automation)
**Assessor:** Relayflow Lead

## The question

Gate 3's definition of done (ops/TARGET.md line 82) requires `cd sdk && npm test` to be green. However, SDK tests are currently RED with 19 failures out of 197 tests.

**The failures appear to be pre-existing and unrelated to gate 3's scope:**

Gate 3 scope is: "Wire the review-swarm to fire on PR open via GitHub Actions + `agent-relay cloud run`. CODE task, `.github/workflows/`-side."

The SDK test failures are:
- 17 failures in `tests/cli.test.ts` related to CLI resolution, kernel dialect recognition, and journal protocol
- 2 failures in `tests/bin.test.ts` related to auth probe classification

These are kernel/CLI integration issues, NOT GitHub Actions workflow issues. Creating `.github/workflows/review-swarm.yml` will not affect these tests.

## Sample failure output

```
 FAIL  tests/cli.test.ts > flows check CLI > passes all three canonical ladder flows and prints their resolved CLI
AssertionError: hello-llm: expected 2 to be +0 // Object.is equality
- Expected: 0
+ Received: 2

 FAIL  tests/cli.test.ts > flows check CLI > refuses cli-unauthenticated.flow.yaml with typed kind cli_unauthenticated and exit 2
AssertionError: expected 'REFUSED [cli_missing] Step "edit" dec…' to contain 'REFUSED [cli_unauthenticated]'

 FAIL  tests/cli.test.ts > flows run/resume CLI over the journal protocol > exits 3 and names the parked llm step
AssertionError: expected 2 to be 3 // Object.is equality
- Expected: 3
+ Received: 2
```

## The options

**Option A:** Fix the 19 SDK test failures FIRST, then proceed with gate 3
- **Pros:** Satisfies the literal definition of done; ensures SDK is healthy
- **Cons:** Out of gate 3 scope (SDK-side vs .github-side); delays gate 3; could be fixing unrelated issues

**Option B:** Revise gate 3's definition of done to remove the SDK test requirement
- **Pros:** Stays in gate 3 scope; SDK tests should be addressed separately
- **Cons:** Requires human judgment on whether the requirement is appropriate

**Option C:** Complete the `.github/workflows/review-swarm.yml` code and documentation, file the SDK failures as a separate issue
- **Pros:** Gate 3 code work gets done; SDK issues are tracked separately
- **Cons:** Doesn't satisfy the stated definition of done; partial completion

**Option D:** Declare gate 3 unreachable due to pre-existing SDK failures and STOP
- **Pros:** Honest about the blocker; no work outside scope
- **Cons:** Gate 3 code work doesn't happen; delays the review automation

## My recommendation

**Option B** — revise the definition of done. The SDK test requirement appears to have been written assuming tests would be unaffected, but they're already failing. Gate 3's actual work (the GitHub Actions workflow) is orthogonal to these failures.

The SDK failures should be investigated and fixed, but as a separate work package, not as part of gate 3.

## Decision needed

Which option should I pursue?

If Option A: I will investigate and fix the 19 SDK test failures first.
If Option B: I will complete gate 3 without the SDK test requirement and recommend updating ops/TARGET.md.
If Option C: I will complete the workflow code and file the SDK issues separately.
If Option D: I will declare gate 3 blocked and stop here.
