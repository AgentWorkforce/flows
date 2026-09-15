# Workspace admission retry fix for agent steps

## Problem

The assess-1 step failed with:

```
[assess-1] mcp-args --register failed after 4 attempts; workspace admission retry
budget 240000ms exhausted (exit 1): Error: register failed: registration for 'lead'
was rate-limited; retry after 60s: Workspace write capacity is busy; retry with backoff
(code: workspace_busy; attempts: 1)
```

## Root Cause

Agent steps use the Agent Relay MCP to register in a workspace. When the workspace
experiences high load, it returns a `workspace_busy` rate-limit error requesting a
60-second backoff before retry.

The default error handling strategy inherited from `applyReliabilityDefaults()` uses:
- maxRetries: 2
- retryDelayMs: 1000

This means 3 total attempts (initial + 2 retries) spaced 1 second apart = 2 seconds
total retry duration, against a requested 60-second backoff. The retries are exhausted
before the requested backoff period even begins.

## Solution

Add explicit error handling configuration to all agent steps:

```yaml
errorHandling:
  strategy: retry
  retryDelayMs: 60000
```

This ensures 60-second delays between retries, honoring the workspace's rate-limit
backoff request. maxRetries continues to be inherited from applyReliabilityDefaults
(currently 2), giving sufficient retry budget: 2 retries × 60s = 120s added per step,
well within step timeout bounds.

## Precedent

This exact fix was already applied to `workflows/review-swarm.yaml` for the same
workspace_busy failures. See the comment block starting at line ~15 in that file
documenting the issue and solution.

## Files Modified

Core workflows (all have agent steps):
- workflows/drive.yaml (4 agent steps: assess, build, review, log)
- workflows/drive-cloud.yaml (regenerated from drive.yaml)
- workflows/watchdog.yaml (1 agent step: check)

Additional workflows that also need this fix:
- workflows/bootstrap-gate1.yaml (5 agent steps)
- workflows/daemon-lifecycle.yaml (5 agent steps)

## Verification

After this fix, the assess-1 step retry will:
1. Initial attempt fails with workspace_busy
2. Wait 60 seconds (honoring the rate-limit)
3. Retry attempt 1
4. If still busy, wait another 60 seconds
5. Retry attempt 2

Total: up to 120 seconds of backoff, vs the previous 2 seconds.

The step timeout (1800000ms = 30 minutes) provides ample headroom for this retry budget.
