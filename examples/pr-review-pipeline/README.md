# pr-review-pipeline

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

Unlike the other two examples in this directory, this one never calls
`f.human` — nothing here needs it to make sense as a demonstration.

## Status: refused before execution

WS-13 invoked this example with the packed CLI and `--local-agent`. It
refused the unsupported `budget` header before entering the body. See the
[gallery](../README.md) for the exact command, output, and elapsed time.
The remaining limitations below describe what still needs to land after that
first refusal is resolved.

```sh
cd packages/surface && npm run typecheck:examples
```

`f.agent(...)` builds a real step but parks without a worker attached, same
as every other example in this repo today. Everything else in this flow —
the fan-out, the gates, the reconciliation step — is otherwise ordinary use
of the shipped `@relayflows/surface` contract.
