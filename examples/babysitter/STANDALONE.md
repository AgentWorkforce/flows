# Standalone Babysitter (v1: diagnose and comment)

`standalone.ts` is the Babysitter that Cloud launches from a GitHub webhook. It
needs no Relay runtime. v1 diagnoses and posts one comment; it never pushes,
merges, approves or requests changes. Pushing waits on gate 8 / #442.

Nothing is enabled by merging this. The exact deployable source is committed
at `artifacts/babysitter-standalone.flow.ts`, with its byte count and SHA-256
in `artifacts/babysitter-standalone.manifest.json`. The manifest also pins the
credential-free operator policy and the explicit
`enforcedAgentWriteScope: true` runtime assertion. Cloud must bind that exact
artifact identity to its daemon-only GitHub read/comment capability before an
operator deploys it (see "Deployment prerequisite" below).

## Launch input

Cloud's default body receives the normalized pull-request input
(`docs/CLOUD.md`, "pull-request run") plus a Babysitter block written by the
drain from the bound lineage:

```jsonc
{
  "pullRequest": { "owner": "acme", "repo": "widgets", "number": 7, "headSha": "…" }, // hint
  "event": { "provider": "github", "eventType": "check_run.completed", "deliveryId": "…" },
  "babysitter": {
    "pullRequest": { "owner": "acme", "repo": "widgets", "number": 7 },          // the binding
    "originContext": { "status": "ok" | "degraded", "source": "claude" | "codex",  // cloud#4144
                       "sessionId": "…", "rootSessionId": "…", "firstPrompt": "…", "events": [ … ] }
  }
}
```

The committed operator policy is `standalone-policy.json`: `botLogin` is
`agent-relay-code[bot]` and the opt-in label is `babysit`. It contains no
credential. With no `agentCli`, the agent runs the origin session's own CLI,
so Claude and Codex sessions both work. The generated manifest therefore
requires both harnesses explicitly; an operator must connect and declare both
when deploying this source rather than relying on the static default branch
reported by `flows check`.

## Body, in order

1. **Bound PR only.** `binding.ts` (shared with `hosted.ts`) throws on any
   other provider, host, repository, PR number, undeclared subscription or
   invalid delivery id, before any effect. No `babysitter.pullRequest` →
   `needs_human`.
2. **Fail closed without origin.** Absent, `missing`, malformed or
   prompt-less `originContext` → `needs_human`, no live read, no agent.
3. **Webhook is a hint.** `readState` rereads GitHub; `bindHead` binds the
   live head. One observation line logs `key=babysitter:<event>:<pr>@<head>`,
   which is the same for every delivery of the same event at the same live
   state.
4. **Decline when nothing is actionable.** Closed, merged, draft or skip
   label (`eligible`); the `babysit` label absent from *live* labels; this head
   already reported by `botLogin` (its own comments' markers, all pages); or no
   failing check run or commit status, standing change request (all review
   pages), or new authorised `@babysitter` directive (PR author, or
   `OWNER`/`MEMBER`/`COLLABORATOR`, after Babysitter's last comment). The
   signal read always fits the journal (50KB): long text is shortened and
   marked `[truncated]` (never below 200 characters), then the oldest
   comments are dropped. Failing checks and change requests are never
   dropped. Report history comes back as one boolean for this head, so it
   cannot grow the payload.
5. **One agent with the original scope.** The task opens with the origin
   session's first prompt verbatim, between fence lines the prompt cannot
   contain, as the task definition. Then the bounded origin events and what
   changed, marked as untrusted data, and the diagnose-only rules.
6. **Reread before concluding.** If the head moved or the PR left scope,
   including the opt-in label being withdrawn, decline without reporting.
7. **One comment.** It carries the `<!-- babysitter:report <pr>@<head> -->`
   marker and names the inherited session ids. The agent's output is bounded,
   `@`-mentions are neutralised, and the original prompt is redacted from it
   (whole, and any identifying line of it), so the prompt text is never
   published even if the agent quotes it. No provider claim or precondition
   guards an issue comment (`capabilities.atomicPrPublication` is `false`), so
   the write is settled after the fact:
   - **Concurrent runs:** every run that posted lists this bot's reports with
     the same marker, and any run whose comment is not the earliest deletes
     its own and ends `declined`. Racing runs converge on one report.
   - **Head or scope changed during the post:** the head and scope are read
     again. If the head moved, the comment is prefixed "Superseded" with both
     heads. If the PR left scope (closed, draft, skip label, opt-in label
     removed), it is prefixed "Withdrawn". Either way the run ends `declined`.
   - Otherwise `f.done('success')`.

Caps (5 acting runs per PR, 2 per head, 30-day expiry), the opt-in label at
bind time, and who may bind are Cloud's (lineage + drain). The flow adds
the live-label check and once-per-head reporting as defense in depth.

## Why no agent-sessions MCP

The woken agent does not get `ai-hist-mcp` or any relayhistory credential.
The paths below are in other repositories, read at these commits:
AgentWorkforce/relayhistory-cloud `6c1e33e` (under `packages/relayhistory/src/`),
AgentWorkforce/relayhistory `6d635f2`, AgentWorkforce/cloud `377aa10`.

- **relayhistory-cloud has no token scoped to one session.** Its scopes are
  `rth:read` and `rth:sync` (relayhistory-cloud `auth/tokens.ts:27`). `auth_sessions` holds only
  user, org and workspace. RelayAuth JWTs supply only those claims plus
  `scope` (relayhistory-cloud `auth/relayauth.ts:231-281`). Read routes take the session id from
  the URL and filter by org only, e.g. `GET /v1/sessions/:id/turns` →
  `listConversationTurns(db, auth.orgId, sessionId)` (relayhistory-cloud
  `routes/turns.ts`). A
  prompt-injected agent holding `rth:read` could read every session in the
  org.
- **`ai-hist-mcp` reads the local SQLite only.** relayhistory `sdk-ts/src/mcp-server.ts`
  imports the local SDK, not the cloud client. Its `remote` scope means
  provider source plugins, and the base distribution "never reads
  credentials" (relayhistory `crates/ai-hist/src/remote.rs:1-3`). In a sandbox it would
  have no data.

So Cloud's already-fetched, bounded origin context is inlined instead.
Follow-up needed to wire the MCP safely:

1. relayhistory-cloud: a read scope bound to one session, e.g. an
   `rth:read:session` token whose `auth_sessions` row carries `session_id`
   (and `source`). The read routes under `/v1/sessions/:id/*` must enforce
   that row's session id, and every listing or search route must refuse the
   token. It should be minted by Cloud per run, short-lived (run lifetime),
   and include the parent chain only if explicitly listed.
2. ai-hist-mcp: a remote read mode that talks to relayhistory-cloud with
   such a token (today it has none).

## Deployment prerequisite: enforce the asserted agent scope

`capabilities.enforcedAgentWriteScope` is `false`, and the body returns
`needs_human` before `f.agent`. The committed artifact deliberately supplies
the runtime assertion as `true`, so it must not be deployed by a generic
launcher. The no-push guarantee depends on Cloud recognizing the exact
artifact SHA-256 and enforcing the split below:

- Cloud gives the flows CLI process, which runs coding agents in-process, the
  repository grant's environment, including `GH_CONFIG_DIR` and the `GIT_*`
  askpass credentials that can push (AgentWorkforce/cloud `377aa10`,
  `packages/core/src/bootstrap/lib/relayflow-v2-step-env.ts`,
  `relayflowV2ChildEnvironments`: `cliEnv = { ...daemonEnv, … }`).
- The flows worker passes its whole environment to the agent
  (this repository, `packages/sdk/src/worker-cli.ts`).
- `permissions: { accessPreset: 'readonly' }` is recorded but not enforced
  (#442; `packages/sdk/src/permissions-preflight.ts`).

Cloud must launch this flow's agent without repository credentials in
`cliEnv`, while its daemon-owned `f.run` environment receives only the
pull-request read/comment capability. There is no checkout, repository grant,
house funding, push, merge, or review capability. The launcher must fail
closed for an unknown artifact digest or any broader permission request.

The source-level default remains closed. Unit tests pass
`{ enforcedAgentWriteScope: true }` to prove the body under that platform
fact; the committed artifact makes the same assertion reviewable and
content-addressable for Cloud's allowlist.

## Verify

```bash
node --experimental-strip-types --test examples/babysitter/tests/standalone.test.ts
node examples/babysitter/build-standalone.mjs --check
node examples/babysitter/build-standalone.mjs
node packages/sdk/dist/cli.js check examples/babysitter/artifacts/babysitter-standalone.flow.ts
```

Literal output: `evidence/standalone/`. Every file is the unedited output of
the command it shows.
- `01-red.txt`: the first red. `07-review-red.txt`, `09-events-red.txt`,
  `11-round3-red.txt`, `12-journal-budget-red.txt` and
  `13-history-floor-red.txt`: the red for each review
  round, captured with the code from before that fix and the tests from the
  fix commit.
- `02-green.txt`: the standalone and reader suites at this head.
- `03-all-babysitter-tests.txt`: every babysitter suite.
- `04-typecheck.txt` and `05-bundle-flows-check.txt`: typecheck, and the
  bundle plus `flows check`.
- `06-mutations.txt`: the output of `mutations.sh`. Six mutations, each
  caught by a named test, each file restored byte-for-byte. The script exits
  nonzero if a mutation survives or does not apply, and restores the file if
  interrupted.
