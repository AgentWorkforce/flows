// pr-review — this repository's own pull-request reviewer, a v2 relayflow.
//
// Deployed to Agent Relay Cloud as a `pull_request` listener on
// AgentWorkforce/flows (see workflows/README.md). Cloud checks out the PR
// head, passes `input.pullRequest`, and runs this body. Three reviewers read
// the same diff through lenses that match this codebase — the Rust kernel,
// the TypeScript SDK/surface, and the examples + docs that make claims about
// them — each gated on writing findings. A reconciliation step then looks for
// places two lenses disagree and posts the reconciled verdict as one PR
// comment, so the review is on the PR, not only in run artifacts.
//
// Local: flows run workflows/pr-review.flow.ts --local-agent \
//          --input '{"diffRange":"origin/main...HEAD"}'
// (needs a flows.json naming the agent CLI; the comment step is skipped
// without a pull request).

import { flow } from "@relayflows/surface";

const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export interface PrReviewInput {
  /** Local runs: e.g. "origin/main...HEAD". Cloud runs derive it from pullRequest. */
  diffRange?: string;
  /** Present on Cloud `--on github:events=pull_request` runs (docs/CLOUD.md). */
  pullRequest?: { number: number; baseRef: string; headSha: string; draft?: boolean; title?: string };
  approver?: string;
}

const LENSES = {
  kernel:
    "the Rust kernel under kernel/ (relayflowd, relayflowd-core): journal and " +
    "machine invariants (a step completes exactly once; completion and " +
    "run-terminal actions are separate), lease and park semantics, verb " +
    "contracts in DESIGN.md, and anything that could make resume or replay " +
    "diverge from the first run",
  sdk:
    "the TypeScript SDK and surface under packages/: preflight refusal " +
    "shapes and their names, the authored-flow executor and lowering, CLI " +
    "argument parsing and USAGE, Cloud HTTP contracts (cloud-*.ts), shell " +
    "quoting of anything interpolated into f.run, and test coverage for each " +
    "new branch",
  docs:
    "examples/ and docs/ (SURFACE.md, CLOUD.md, README.md): every claim a " +
    "doc or example makes about a verb, flag, refusal, or Cloud behaviour " +
    "must match what the diff (and the code it touches) actually does; flag " +
    "stale status lines, commands that would not run, and inputs the example " +
    "would not receive on Cloud",
} as const;
type Lens = keyof typeof LENSES;
const findingsPath = (lens: Lens): string => `.relayflow/review/${lens}.md`;

export default flow<PrReviewInput>(
  "flows-pr-review",
  { budget: "$4/run" },
  async (f, input) => {
    const pr = input.pullRequest;
    if (pr?.draft) return f.done("declined"); // drafts are reviewed once marked ready

    let range = input.diffRange;
    if (range === undefined) {
      if (pr === undefined) {
        throw new Error("flows-pr-review needs diffRange (local) or input.pullRequest (a pull_request trigger)");
      }
      // Cloud clones at the PR head; fetch the base tip and deepen until the
      // merge base exists so the three-dot diff is the PR's own change.
      await f.run(
        `git fetch --no-tags --depth=200 origin ${shellWord(pr.baseRef)} && `
          + `until git merge-base FETCH_HEAD ${shellWord(pr.headSha)} >/dev/null 2>&1; do `
          + `git fetch --no-tags --deepen=500 origin ${shellWord(pr.baseRef)} || exit 1; done`,
        { timeout: "5m" },
      );
      range = `FETCH_HEAD...${pr.headSha}`;
    }

    // Evidence transcripts and generated docs are noise for a reviewer.
    const diff = await f
      .run(
        `git diff ${shellWord(range)} -- . ':!docs/evidence/**' ':!evidence/**' ':!**/*.lock' ':!package-lock.json'`,
        { timeout: "2m" },
      )
      .gate((out) => out.trim().length > 0, "nothing to review — the diff is empty");
    await f.run("mkdir -p .relayflow/review");

    await Promise.all(
      (Object.keys(LENSES) as Lens[]).map((lens) =>
        f
          .agent(`${lens}-reviewer`, {
            task:
              `You are reviewing a pull request to AgentWorkforce/flows through ONE lens: ${LENSES[lens]}. ` +
              `Ignore everything outside that lens. Read the surrounding code where the diff is not self-explanatory. ` +
              `Write every finding to ${findingsPath(lens)} as a Markdown list — each item: file:line, severity ` +
              `(blocker / should-fix / nit), what is wrong, and the concrete fix. If there is nothing, write exactly ` +
              `"No ${lens} findings." Do not modify any other file.\n\n${diff}`,
          })
          .gate({ type: "artifact_exists", path: findingsPath(lens) }),
      ),
    );

    await f
      .agent("consensus", {
        task:
          `Read ${(Object.keys(LENSES) as Lens[]).map(findingsPath).join(", ")}. Produce ONE review comment for the ` +
          `pull request in .relayflow/review/consensus.md: a one-line verdict (APPROVE / REQUEST CHANGES / COMMENT), ` +
          `then the blockers, then should-fixes, each with file:line. Where two lenses reached opposite conclusions ` +
          `about the same spot, resolve it with a reason or list it under "Unresolved" with both positions — never ` +
          `let one silently win. Drop nits unless there are no other findings. Start the file with ` +
          `"<!-- flows-pr-review -->" so re-runs can be recognised. Do not modify any other file.`,
      })
      .gate(
        (r) => r.artifacts.includes(".relayflow/review/consensus.md"),
        "the consensus step must write .relayflow/review/consensus.md",
      );

    if (pr !== undefined) {
      // The GitHub mount Cloud provides authenticates gh; the comment is the
      // deliverable, so its failure fails the run rather than hiding.
      await f.run(
        `gh pr comment ${pr.number} --repo AgentWorkforce/flows --body-file .relayflow/review/consensus.md`,
        { timeout: "2m" },
      );
    }
    f.done("success");
  },
);
