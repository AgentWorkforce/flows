# pr-review-pipeline

Runs locally and on Cloud. From a checkout with a `flows.json` naming the
agent CLI (`{"cli": "claude"}` is enough — see *Running it* below):

```sh
flows run pr-review-pipeline.flow.ts --local-agent --input '{"diffRange":"origin/main...HEAD"}'
```

To have it review every pull request of a repo on Cloud:

```sh
flows deploy pr-review-pipeline.flow.ts --repo acme/api --on github:events=pull_request --approver you
```

**Like I'm 5:** Instead of one reviewer reading your whole pull request,
three little reviewers each look for one thing — one only checks for
security holes, one only checks for logic bugs, one only checks for slow
code. They all work at the same time. Then a fourth robot reads what all
three wrote and specifically looks for fights — like one saying "this is
fine" and another saying "this is dangerous" about the exact same line. It
doesn't just let one opinion quietly win; it writes down that they disagree.

## The shape

```
git diff → [security, correctness, performance] reviewers (parallel, gated) → consensus (agent, gated) → done
```

`pr-review-pipeline.flow.ts` is written against the real
`@relayflows/surface` package. It mirrors a real, shipping product's actual
mechanism — My Senior Dev's multi-agent PR review — in two layers:

- **Fan-out by lens, not by "review everything."** Each reviewer is told to
  look at exactly one dimension and ignore the rest, and is gated on writing
  its findings to its own file (`review/<lens>.json`) — even "no issues
  found" has to be written down, so a reviewer can't pass by staying silent.
- **Reconciliation, not aggregation.** The `consensus` step's task is
  explicitly to find *disagreement* between lenses on the same spot in the
  diff and resolve or flag it — the same thing My Senior Dev's real
  coordination engine does (`hasOppositeFixDirection`,
  `looksLikeFalsePositiveDispute`) rather than just concatenating three
  reports into one.

## Running it

`flows.json` selects the CLI for the agent steps; `{"cli": "claude"}` (or
`codex`) is all it needs. A `flows.json` without a `models` list is **not** a
model registry — the adapter's default model is used, exactly as with no
`flows.json` at all. Add `"models": [...]` only when you want to pin an exact
allowlist (an empty list then refuses everything, on purpose).

Proven 2026-09-18 against a fresh directory with `@relayflows/surface@2.0.17`
and a local `claude`: 9 steps completed, the three lens gates passed on the
journaled `review/<lens>.json` artifacts, the consensus predicate gate passed,
`review/consensus.json` written — 74s wall clock. Before the SDK fix in the
same change, the exact same setup was refused with `agent_cli_unresolved:
... model "claude-opus-5" ... is not listed in project model registry`,
because a `flows.json` that only named the CLI was treated as an empty
allowlist. That is what the earlier "BLOCKED" status in this file recorded.

```sh
cd packages/surface && npm run typecheck:examples
```

`--local-agent` attaches a stream-only worker on this machine: no workspace
isolation, the CLI's own access. Workspace permission annotations
(`"...: readwrite"`) are still refused because nothing enforces them yet.
