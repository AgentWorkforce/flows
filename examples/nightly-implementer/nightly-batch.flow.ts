// Top-level batch driver for the nightly implementer.
//
// Fan-out across N per-issue implementer runs. `Promise.all` IS the
// parallelism primitive per RFC-0001 (flows#251) — no separate `parallel:`
// declaration, no dependency-string sugar. A worker that dies inside one
// implementer does not stall the others; the runner reports per-branch
// completion reasons and the aggregate outcome names the survivors.

import { flow, f } from '@relayflows/surface';
import implementIssue from './nightly-implementer.flow';

interface IssueBrief {
  repo: string;
  issue: number;
  briefPath: string;
  declaredFiles: string[];
}

interface BatchInput {
  issues: IssueBrief[];
}

export default flow(async (f, input: BatchInput) => {

  // A single implementer's failure must not sink the batch. The catch
  // folds it into a structured per-issue outcome the aggregator reads.
  // The runner still marks the sub-run as failed; this pattern only
  // controls what the enclosing run reports.
  const outcomes = await Promise.all(
    input.issues.map(async (brief) => {
      try {
        const result = await implementIssue(f, brief);
        return {
          issue: brief.issue,
          repo: brief.repo,
          outcome: 'delivered' as const,
          prUrl: (result as { prUrl?: string }).prUrl ?? null,
        };
      } catch (error) {
        return {
          issue: brief.issue,
          repo: brief.repo,
          outcome: 'failed' as const,
          error: error instanceof Error ? error.message : String(error),
        };
      }
    }),
  );

  // Deterministic summary — a single JSON payload the operator sees on
  // wake, including a bounded diagnostic per outcome. No agent adjudicates
  // this either: the aggregate is mechanical, so a human reading the run
  // report can trust its counts.
  return await f.deterministic({
    id: 'summary',
    command:
      `./scripts/report-batch.sh --outcomes "$OUTCOMES"`,
    input: { OUTCOMES: JSON.stringify(outcomes) },
    verification: {
      type: 'json_schema',
      schema: {
        type: 'object',
        required: ['delivered', 'failed', 'items'],
        properties: {
          delivered: { type: 'number' },
          failed: { type: 'number' },
          items: {
            type: 'array',
            items: {
              type: 'object',
              required: ['issue', 'outcome'],
            },
          },
        },
      },
    },
  });
});
