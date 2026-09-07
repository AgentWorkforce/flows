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
// STATUS: typechecks against the real `@relayflows/surface` package (see
// ../tsconfig.json / `npm --prefix packages/surface run typecheck:examples`)
// but does not run yet — `f.agent` parks without an attached worker. Unlike
// the other two examples, this one never calls `f.human`, so nothing here
// depends on that verb being wired up.

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

    await Promise.all(
      LENSES.map((lens) =>
        f
          .agent(`${lens}-reviewer`, {
            task:
              `Review this diff for ${lens} issues ONLY — ignore everything else. ` +
              `Write every finding, or an explicit "no issues found", to ` +
              `${findingsPath(lens)}.\n\n${diff}`,
            workspace: "review/: readwrite",
          })
          .gate(
            (r) => r.artifacts.includes(findingsPath(lens)),
            `the ${lens} reviewer must write ${findingsPath(lens)}, even to report nothing`,
          ),
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
        workspace: "review/: readwrite",
      })
      .gate(
        (r) => r.artifacts.includes("review/consensus.json"),
        "the consensus step must write review/consensus.json",
      );

    f.done("success");
  },
);
