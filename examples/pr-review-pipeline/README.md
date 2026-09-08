# pr-review-pipeline

**BLOCKED — not runnable on the current authored executor.** The candidate
CLI refuses the `budget` header before any step runs (exit 2, 0.252s).
[Exact command and captured output](../../docs/evidence/ws13/followup/gallery-pr-review-pipeline.txt).
The SDK/kernel capability owner must supply budget-header support, postfix
artifact gates, and the declared workspace behavior before this example can
be advertised as working. Its existing requirements remain intact.

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

## Status: refused before execution

WS-13 invoked this example with the packed CLI and `--local-agent`. It
refused the unsupported `budget` header before entering the body. See the
[gallery](../README.md) for the exact command, output, and elapsed time.
The remaining limitations below describe what still needs to land after that
first refusal is resolved.

```sh
cd packages/surface && npm run typecheck:examples
```

`--local-agent` attaches a stream-only worker. Budget headers, postfix gates
and workspace permission annotations are still refused by the authored
executor, even though the surface package can represent their types.
