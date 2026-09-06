# NEXT — give the review gate a credential

**Scope:** one Actions secret and two `env:` lines in
`.github/workflows/review-swarm.yml`. Nothing else.

**The Relayflow Lead cannot do this one.** RFC-0001 decision #6 and the
charter's second hard rail: it cannot edit the gates that judge its work.

## The headline

**The review swarm has never succeeded.**

```
TOTAL runs: 76      failure: 75      cancelled: 1      successes: 0
first  2026-08-30T20:22:22Z
latest 2026-09-06T04:03:35Z
```

Treat any claim that gate 3 is "architecturally complete" against that number.
Most of its nine requirements describe behaviour downstream of a launch that has
never happened, so nothing past authentication has ever executed.

## What already shipped (2026-09-06)

Four layers, each revealing the next:

| step | failed because | closed by |
|---|---|---|
| `Validate cloud authentication` | repo had zero Actions secrets | `RELAY_WORKSPACE_KEY` added |
| `Prepare review input` | gate scripts were mode `100644`, exit 126 | #172 |
| `Launch cloud swarm` | CLI never installed, exit 127 | #198 |
| `Launch cloud swarm` | pinned runtime read no API key | #198 (pin → 11.10.3) |

Also landed: #203 (whole-line verdict matching, `jq -er` on the poll response),
#202 (a missing reviews directory yields `MISSING` rather than a `find` error).

## The one thing left

The job now has a CLI that can read an API key, and no key to read.
`agent-relay cloud run` falls back to the interactive device flow and dies after
ten minutes:

```
Device login expired before it was approved. Run the command again to get a new code.
```

`@agent-relay/cloud@11.10.3` resolves `CLOUD_API_KEY` through
`WorkflowApiKeyClient.fromEnv`, which `workflowApiClient` prefers over the stored
login. With the variable set, the device flow is never reached.

## What to do

1. **Mint the credential.** `AgentWorkforce/cloud` →
   `docs/runbooks/relay-ci-workflow-credential.md`, profile
   `CI_TOKEN_PROFILE=workflow-invoke`. Non-human, workspace-bound, scoped to
   exactly `workflow:invoke:read` and `workflow:invoke:write`. The runbook notes
   provisioning and rotation "require no browser login".
2. **Store it.** An operator mints; **a repository administrator stores it**. The
   runbook is explicit that an agent is not authorized to create or update
   GitHub secrets.
3. **Set both variables** on the `Launch cloud swarm` step: `CLOUD_API_URL` and
   `CLOUD_API_KEY`.
4. **Fix the preflight, which currently cannot fail.** `Validate cloud
   authentication` tests that `RELAY_WORKSPACE_KEY` is non-empty, never examines
   the credential `cloud run` uses, and never attempts an authentication — it
   passed green on run 34007204726, whose authentication then failed ten minutes
   later. Assert both variables, the way `AgentWorkforce/relay` does:

   ```bash
   test -n "$CLOUD_API_URL"
   test -n "$CLOUD_API_KEY"
   ```

**Precedent:** `AgentWorkforce/relay`'s `.github/workflows/relayflow-pr-proof.yml`
runs this exact shape in production — published CLI, `CLOUD_API_URL` and
`CLOUD_API_KEY` in the environment, no interactive login.

## Definition of done

1. A review-swarm run reaches a step after `Launch cloud swarm` — the first
   non-zero success in this workflow's history.
2. Paste the literal step list showing `Launch cloud swarm` succeeded.
3. If it fails, paste the literal error and STOP. Do not weaken the gate to make
   it green. A gate that passes without running is the failure this whole
   sequence has been climbing out of.
