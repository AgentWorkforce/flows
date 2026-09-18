// pr-review-pipeline — a v2 relayflow (docs/SURFACE.md dialect).
//
// Multiple review agents look at the same diff from different angles —
// security, correctness, performance — in parallel, each gated on actually
// writing findings rather than just talking. A separate reconciliation agent
// then reads every lens's findings and resolves (or flags) disagreement
// between them: the same two-layer shape My Senior Dev's real multi-agent
// PR review uses — cheap fan-out first, then a reconciliation pass that
// looks specifically for conflicting verdicts rather than just concatenating
// opinions.
//
// STATUS: runs with `flows run pr-review-pipeline.flow.ts --local-agent
// --input '{"diffRange":"main...HEAD"}'` from a checkout with a `flows.json`
// naming the agent CLI. Each lens is gated on a journaled `artifact_exists`
// check — the worker that spawned the agent journals the files it wrote, and
// the gate reads that journal — and the consensus step on a predicate whose
// verdict is journaled as `agent-N.gate`. The steps run in the invoking
// directory (no `workspace:` scoping: the local agent worker accepts
// stream-only steps, and a "...: readwrite" annotation is refused because
// nothing enforces it). Unlike the other two examples, this one never calls
// `f.human`, so nothing here depends on that verb being wired up.

import { flow } from "@relayflows/surface";

const LENSES = ["security", "correctness", "performance"] as const;
type Lens = (typeof LENSES)[number];

export interface PrReviewInput {
  /** e.g. "origin/main...HEAD", or a PR's merge-base range. */
  diffRange: string;
}

function findingsPath(lens: Lens): string {
  return `review/${lens}.json`;
}

export default flow<PrReviewInput>(
  "pr-review-pipeline",
  { budget: "$3/run" },
  async (f, input) => {
    const diff = await f
      .run(`git diff ${input.diffRange}`)
      .gate((out) => out.trim().length > 0, "nothing to review — the diff is empty");
    await f.run("mkdir -p review");

    await Promise.all(
      LENSES.map((lens) =>
        f
          .agent(`${lens}-reviewer`, {
            task:
              `Review this diff for ${lens} issues ONLY — ignore everything else. ` +
              `Write every finding, or an explicit "no issues found", to ` +
              `${findingsPath(lens)}.\n\n${diff}`,
          })
          // A named gate: preflightable by `flows check`, evaluated against
          // the artifacts the worker journaled for this step, never the disk.
          .gate({ type: "artifact_exists", path: findingsPath(lens) }),
      ),
    );

    // Reconciliation, not aggregation: this agent's job is to find the
    // places two lenses disagree about the same spot in the diff (one says
    // "fine", another says "block") and resolve or flag it, rather than let
    // whichever verdict is read first silently win.
    const consensus = await f
      .agent("consensus", {
        task:
          `Read ${LENSES.map(findingsPath).join(", ")}. Where two reviewers ` +
          `reached opposite verdicts on the same spot in the diff, resolve it ` +
          `or mark it UNRESOLVED with both positions. Write your reconciled ` +
          `verdict to review/consensus.json.`,
      })
      // A predicate gate: author code, run once on the journaled result; its
      // verdict is journaled as `agent-N.gate` so resume/replay never re-run it.
      .gate(
        (r) => r.artifacts.includes("review/consensus.json"),
        "the consensus step must write review/consensus.json",
      );

    f.done("success");
  },
);
