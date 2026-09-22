# Native Babysitter (flow extension)

A schema-2 extension on `software-factory`. Each of its eleven GitHub
subscriptions takes Cloud's normalized delivery descriptor and makes one
`cloud:babysitter-turn` queue request:

```jsonc
// in: Cloud's normalized descriptor, never a raw webhook
{ "event": { "provider": "github", "eventType": "pull_request.labeled", "deliveryId": "…" },
  "pullRequest": { "host": "github", "owner": "…", "repo": "…", "number": 1, "headSha": "<40 hex, optional>" } }
// out: f.capabilities.cloud.babysitterTurn.queue(request)
{ "delivery": { "deliveryId": "…", "provider": "github", "eventType": "pull_request.labeled",
                "pullRequest": { "owner": "…", "repository": "…", "number": 1 } } }
```

The delivery is an envelope, not authority. The handler never sends findings,
prose, a head, label, session, lineage, relay agent, config, merge flag, or
route; Cloud builds the prompt from the live head and the trusted binding. Cloud's
capability adapter checks the envelope against the host-verified dispatch,
loads the persisted activation, rereads the live PR (open, exact `babysit`
label, head), and resolves the one bound Codex session. It answers
`{ receiptId, status: queued | duplicate }` and the run completes `success`;
Cloud dedupes by lineage and live head, so `deliveryId` is provenance, not the
idempotency key. Every policy refusal and in-doubt transport failure rejects,
and the run fails once with no retry or fallback. Any other input or receipt,
or a runtime without the capability, fails the run.

## What this does not do

- Hosted execution is still refused. The SDK rejects every matched extension
  handler with `plugin_unsupported` until manifest permissions are enforced
  (#549, gate 8 / #442). This package does not change that.
- The SDK context has no `capabilities.cloud.babysitterTurn`, and Cloud's
  adapter is not merged. Both must land before a turn can happen.
- It is not the legacy `examples/babysitter` (Claude review lenses, GitHub
  comments, merge-gate hook). It holds no GitHub write authority.
- `compat` needs a surface release after 2.0.25: the published 2.0.25 event
  registry cannot route `labeled`, `unlabeled`, or `ready_for_review`.

Catalog export follows `docs/BABYSITTER-CATALOG-HANDOFF.md`, with
`#extensions/babysitter` as the path, after human review and merge.
