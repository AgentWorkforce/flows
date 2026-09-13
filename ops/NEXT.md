# NEXT — BLOCKED: Misaligned work package and SDK type errors

**Status:** BLOCKED_NEEDS_HUMAN

## Summary

The prior ops/NEXT.md work package (document secrets in README.md) has been COMPLETED - README.md lines 80-90 now contain the required documentation. However, this run cannot proceed with new work because:

1. **TARGET.md gate/scope mismatch** - Claims gate 3 but describes gate 2 work (hn-monitor)
2. **SDK type errors** - 74 TypeScript compilation errors block any SDK work

## Evidence: Prior Work Package Completed

**Prior ops/NEXT.md (line 50-52) claimed:**
```
grep -c "RELAY_WORKSPACE_KEY\|CLOUD_API_KEY" README.md
# Output: 0
```

**Current reality:**
```
$ grep -c "RELAY_WORKSPACE_KEY\|CLOUD_API_KEY" README.md
2
```

**README.md lines 80-90 now contain:**
```markdown
## GitHub Actions Secrets

The `.github/workflows/review-swarm.yml` workflow requires the following secrets and variables to be configured in repository settings:

- **`CLOUD_API_KEY`** (secret) — Agent Relay Cloud API credential for launching cloud workflows. Mint per `AgentWorkforce/cloud → docs/runbooks/relay-ci-workflow-credential.md` with profile `workflow-invoke` and scopes `workflow:invoke:read` and `workflow:invoke:write`. Store in Repository Settings → Secrets and variables → Actions → New repository secret.

- **`RELAY_WORKSPACE_KEY`** (secret) — Agent Relay workspace key for review swarm communication. Contact repository administrator for the workspace key.

- **`CLOUD_API_URL`** (variable) — Cloud API endpoint, typically `https://agentrelay.com/cloud`. Set as a repository variable. Defaults to production endpoint if not set.

See `.github/workflows/review-swarm.yml` for implementation details.
```

All verification commands from prior NEXT.md pass:
```
$ bash -n .github/workflows/scripts/swarm-post.sh && bash -n .github/workflows/scripts/swarm-prepare.sh && bash -n .github/workflows/scripts/swarm-verdict.sh && echo "All bash scripts parse OK"
All bash scripts parse OK

$ python3 -c "import yaml; yaml.safe_load(open('.github/workflows/review-swarm.yml'))" && python3 -c "import yaml; yaml.safe_load(open('workflows/review-swarm.yaml'))" && echo "YAML files parse OK"
YAML files parse OK

$ grep -i "whitelist\|github.event.pull_request.user.login" .github/workflows/review-swarm.yml || echo "GOOD: No author whitelist found"
GOOD: No author whitelist found
```

## Blocker 1: TARGET.md Gate/Scope Mismatch

**ops/TARGET.md line 1-6 says:**
```
# TARGET — gate 3

This run is pinned to **gate 3** and must not work on any other gate.

**Scope:** Build sub-PR A of the Gate 2 push: a real `hn-monitor` polling runner in the SDK. CODE task, `sdk/src/`-side.
```

**The conflict:**
- Header claims: gate 3
- Content describes: hn-monitor polling runner (which is gate 2 work per RFC-0001 §3)
- RFC-0001 §3 gate 2: "a relayflow can power a proactive agent" - Done when hn-monitor runs in production
- RFC-0001 §3 gate 3: "a relayflow can power a factory → Software Garden" - Done when labeled issue → PR with kernel leases

**ops/STATE.md line 39:**
"Gate 2 — proactive agent: AMBER, unattended trigger-plane proven, two clauses remain."

**ops/STATE.md line 26:**
"Gates 2, 3, 4, 5, 7, 8, 9: RED / AMBER as noted." Gate 2 is AMBER; gate 3 is RED.

**Charter guidance (charter/LEAD.md):**
"It is the operator's scoping decision and it overrides your own judgement about priority — several runs execute in parallel, each pinned to a different gate, and a run that wanders outside its target will collide with a sibling. Stay inside it or, if the target is genuinely unreachable, say so in ops/NEEDS_HUMAN.md rather than silently choosing different work."

This run cannot proceed without human clarification: is the target gate 2 (matching the hn-monitor scope) or gate 3 (matching the header)?

## Blocker 2: SDK Type Errors

Even if the scope conflict is resolved, **SDK tests currently fail** with 74 TypeScript compilation errors. These block any SDK work:

```
$ cd packages/sdk && npm test
> @relayflows/sdk@2.0.8 typecheck
> tsc --noEmit && tsc -p tsconfig.type-tests.json

src/authored-flow-executor.ts(17,8): error TS2305: Module '"@relayflows/surface"' has no exported member 'LlmOptions'.
src/authored-flow-executor.ts(21,8): error TS2724: '"@relayflows/surface"' has no exported member named 'FlowCompletionReason'. Did you mean 'CompletionReason'?
src/authored-flow-executor.ts(25,10): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'createHelpers'.
src/authored-flow-executor.ts(25,25): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'helperProviders'.
src/authored-flow-executor.ts(25,47): error TS2305: Module '"@relayflows/surface/runtime"' has no exported member 'HelperCall'.
... (69 more errors)
```

Root cause appears to be dependency version mismatch with @relayflows/surface - the SDK imports types that don't exist in the installed version.

## Kernel Tests: GREEN

```
$ cd kernel && sh ../ops/cargo.sh test --workspace
test result: ok. 28 passed; 0 failed; 0 ignored; 0 measured; 0 filtered out
```

## Human Decision Required

**Question 1: What is the correct gate target for this run?**
- Option A: Gate 2 (matching TARGET.md's hn-monitor scope, contradicting its header)
- Option B: Gate 3 (matching TARGET.md's header, contradicting its scope description)
- Option C: Neither - this TARGET.md is stale/malformed and should be corrected

**Question 2: How should SDK type errors be handled?**
- Option A: Fix @relayflows/surface dependency mismatch as the work package for this run
- Option B: This is a repo-wide blocker; human should fix before any run proceeds with SDK work
- Option C: SDK is out of scope for gate 3; ignore the errors and work on non-SDK gate 3 tasks

**Question 3: What is the actual gate 3 work?**
If this run's true target is gate 3 (Software Garden), RFC-0001 §3's done-when is high-level: "labeled issue flows to PR with kernel leases." What is the FIRST concrete sub-task to start gate 3?
- Does gate 3 scaffolding exist anywhere in the repo?
- Should this run assess what's needed and file a detailed gate-3 work breakdown?
- Or is there already a defined gate-3 first task that STATE.md/DIRECTIVES.md doesn't mention?

## Recommendation

**Option C + Option B** - Both TARGET.md and the SDK are malformed:
1. TARGET.md has an internal contradiction (gate 3 header, gate 2 content)
2. SDK type errors are repo-wide and block any SDK work

This run should BLOCK with this assessment rather than silently choosing work that may:
- Collide with a parallel run targeting the same gate
- Work on the wrong gate per the pinning contract
- Fail immediately due to SDK type errors

The prior ops/NEXT.md work (document secrets) is complete. The repo is ready for new work once the scope conflict and SDK errors are resolved by a human.
