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
// (the comment step is skipped without a pull request). The agent CLI is
// pinned to `claude` below, so no flows.json is needed.
//
// This file reviewed its own first version (run 01M2TQC0JF1WB1RAS9PTBXJK32,
// 2026-09-18): the findings directory, the diff transport, the CLI pin, the
// comment transport, the fetch loop bound and the re-run behaviour below all
// come from that review.

import { flow } from "@relayflows/surface";

const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

export interface PrReviewInput {
  /** Local runs: e.g. "origin/main...HEAD". Cloud runs derive it from pullRequest. */
  diffRange?: string;
  /** Present on Cloud `--on github:events=pull_request` runs (docs/CLOUD.md). */
  pullRequest?: {
    number: number; baseRef: string; headSha: string; draft?: boolean; title?: string;
    /** Present when the wake was a submitted review (docs/CLOUD.md); we do not re-review on those. */
    review?: unknown;
  };
  approver?: string;
}

interface Pr { number: number; baseRef: string; headSha: string; draft: boolean; reviewWake: boolean }

// `flow<Input>` is type-only; the listener input crosses a network boundary,
// and baseRef/headSha reach a shell, so validate before either does.
function prFromInput(input: PrReviewInput): Pr | undefined {
  const pr = input.pullRequest;
  if (pr === undefined) return undefined;
  if (!Number.isSafeInteger(pr.number) || pr.number <= 0) throw new Error(`flows-pr-review: pullRequest.number is not a positive integer: ${JSON.stringify(pr.number)}`);
  if (typeof pr.baseRef !== "string" || pr.baseRef.length === 0 || pr.baseRef.startsWith("-")) throw new Error("flows-pr-review: pullRequest.baseRef must be a non-empty ref name");
  if (typeof pr.headSha !== "string" || !/^[0-9a-f]{40}$/u.test(pr.headSha)) throw new Error("flows-pr-review: pullRequest.headSha must be a 40-hex commit");
  return { number: pr.number, baseRef: pr.baseRef, headSha: pr.headSha, draft: pr.draft === true, reviewWake: pr.review !== undefined };
}

const REPO = { owner: "AgentWorkforce", repo: "flows" } as const;
const CLI = "claude";

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
  repo:
    "everything the other lenses do not own: .github/workflows (publish, " +
    "runtime artifact, review swarm, guards), scripts/, ops/, workflows/, " +
    "testdata/, package manifests and lockfiles, tsconfigs, and generated " +
    "files — release and pin safety, CI that would silently stop running, " +
    "secrets or tokens in the diff, and files that should not be committed",
} as const;
type Lens = keyof typeof LENSES;
const findingsPath = (lens: Lens): string => `review/${lens}.md`;
const DIFF = "review/diff.patch";
const CONSENSUS = "review/consensus.md";

export default flow<PrReviewInput>(
  "flows-pr-review",
  { budget: "$4/run" },
  async (f, input) => {
    const pr = prFromInput(input);
    // Cloud wakes on opened / new commits / reopened / reviewed, not on
    // ready_for_review: a draft is reviewed at its next push, reopen or review
    // after being marked ready.
    if (pr?.draft) return f.done("declined");
    // The same listener wakes when a review is submitted; a reviewer's
    // comment on the PR is not a reason to review the code again.
    if (pr?.reviewWake) return f.done("declined");

    let range = input.diffRange;
    if (range === undefined) {
      if (pr === undefined) {
        throw new Error("flows-pr-review needs diffRange (local) or input.pullRequest (a pull_request trigger)");
      }
      // Cloud clones at the PR head; fetch the base tip and deepen until the
      // merge base exists so the three-dot diff is the PR's own change. The
      // loop is bounded: on a full clone --deepen is a no-op, and an unrelated
      // head would otherwise spin until the lease expired.
      const base = shellWord(`refs/heads/${pr.baseRef}`);
      await f.run(
        `git fetch --no-tags --depth=200 origin ${base} && n=0; `
          + `until git merge-base FETCH_HEAD ${shellWord(pr.headSha)} >/dev/null 2>&1; do `
          + `n=$((n+1)); [ "$n" -le 5 ] || { echo "no merge base with ${pr.baseRef} after 5 deepens" >&2; exit 1; }; `
          + `git fetch --no-tags --deepen=500 origin ${base} || exit 1; done`,
        { timeout: "5m" },
      );
      range = `FETCH_HEAD...${pr.headSha}`;
    }

    // `review/` is not a dot-directory on purpose: the worker journals the
    // artifacts it finds by scanning the tree, and that scan skips dot
    // entries. It is recreated per run because `artifact_exists` records
    // presence on content change, so a re-run writing the same "No findings"
    // text into a leftover file would fail its gate.
    await f.run("rm -rf review && mkdir -p review");
    // The diff goes through a file, not through f.run's return value: that
    // value is the kernel's stdout tail (64 KiB) and a task string is one
    // argv entry, so a large PR would be reviewed from a silently truncated
    // tail. Evidence transcripts and lockfiles are noise for a reviewer.
    const diffBytes = await f.run(
      `git diff ${shellWord(range)} -- . ':(exclude)docs/evidence/**' ':(exclude)evidence/**' ':(exclude,glob)**/*.lock' ':(exclude)package-lock.json' > ${DIFF} && wc -c < ${DIFF}`,
      { timeout: "2m" },
    );
    // The listener has no path filter, so a PR that only touches excluded
    // paths is a valid wake with nothing to review — decline, don't fail.
    if (Number(diffBytes.trim()) === 0) return f.done("declined");

    await Promise.all(
      (Object.keys(LENSES) as Lens[]).map((lens) =>
        f
          .agent(`${lens}-reviewer`, {
            cli: CLI,
            task:
              `You are reviewing a pull request to AgentWorkforce/flows through ONE lens: ${LENSES[lens]}. ` +
              `Ignore everything outside that lens. The diff is in ${DIFF} (read it; do not run git). Read the ` +
              `surrounding code where the diff is not self-explanatory. Write every finding to ${findingsPath(lens)} ` +
              `as a Markdown list — each item: file:line, severity (blocker / should-fix / nit), what is wrong, and ` +
              `the concrete fix. If there is nothing, write exactly "No ${lens} findings." Do not modify any other file.`,
          })
          .gate({ type: "artifact_exists", path: findingsPath(lens) }),
      ),
    );

    await f
      .agent("consensus", {
        cli: CLI,
        task:
          `Read ${(Object.keys(LENSES) as Lens[]).map(findingsPath).join(", ")} (the diff they reviewed is in ${DIFF}). ` +
          `Produce ONE review comment for the pull request in ${CONSENSUS}: a one-line verdict (APPROVE / REQUEST ` +
          `CHANGES / COMMENT), then the blockers, then should-fixes, each with file:line. Where two lenses reached ` +
          `opposite conclusions about the same spot, resolve it with a reason or list it under "Unresolved" with ` +
          `both positions — never let one silently win. Drop nits unless there are no other findings. Start the ` +
          `file with "<!-- flows-pr-review -->". Do not modify any other file.`,
      })
      .gate((r) => r.artifacts.includes(CONSENSUS), `the consensus step must write ${CONSENSUS}`);

    if (pr !== undefined) {
      // headSha is the wake's snapshot. If the PR moved while the agents ran,
      // a newer wake is reviewing the new commit; don't post a stale verdict.
      // A lookup failure or blank result is a step failure (the run can be
      // resumed), never a reason to drop a finished review.
      const head = await f.run(
        `h=$(git ls-remote --exit-code origin ${shellWord(`refs/pull/${pr.number}/head`)} | cut -f1) && `
          + `printf '%s' "$h" | grep -Eq '^[0-9a-f]{40}$' && printf '%s' "$h"`,
        { timeout: "1m" },
      );
      if (head.trim() !== pr.headSha) return f.done("declined");
      await postComment(f, pr);
    }
    f.done("success");
  },
);

// The comment goes through the REST API with the repository token Cloud puts
// in the sandbox as GH_TOKEN (the same credential git uses there). The
// relayfile GitHub mount behind `f.github.*` is not attached to authored
// runs on Cloud (cloud #3812) — its first live run failed with
// helper_provider.mount_required at exactly this step.
//
// One review comment per PR, edited in place: the marker names the head SHA
// reviewed; an existing marker comment is PATCHed (skipped when it already
// carries this SHA, so a re-dispatched step never double-posts), else one is
// POSTed. The body is bounded from the front (f.run returns a 64 KiB stdout
// *tail*, which would drop the verdict) under GitHub's 65,536-char limit.
const POST_SCRIPT = String.raw`
const [owner, repo, number, headSha, bodyPath] = process.argv.slice(2);
const token = process.env.GH_TOKEN;
if (!token) { console.error("GH_TOKEN is not set; cannot post the review"); process.exit(1); }
const fs = require("fs");
const MARK = "<!-- flows-pr-review";
const marker = MARK + " " + headSha + " -->";
const api = "https://api.github.com/repos/" + owner + "/" + repo;
const headers = { Authorization: "Bearer " + token, Accept: "application/vnd.github+json", "Content-Type": "application/json", "User-Agent": "flows-pr-review" };
async function gh(method, url, body) {
  const res = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  if (!res.ok) { console.error(method + " " + url + " -> " + res.status + " " + (await res.text()).slice(0, 300)); process.exit(1); }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}
(async () => {
  // Collect every marker comment (legacy runs left one per wake).
  const found = [];
  for (let page = 1; page <= 50; page += 1) {
    const list = await gh("GET", api + "/issues/" + number + "/comments?per_page=100&page=" + page);
    for (const c of list) if (typeof c.body === "string" && c.body.startsWith(MARK)) found.push(c);
    if (list.length < 100) break;
    if (page === 50) { console.error("more than 5000 comments; refusing to post without a complete scan"); process.exit(1); }
  }
  const existing = found[0];
  for (const dup of found.slice(1)) { await gh("DELETE", api + "/issues/comments/" + dup.id); console.log("deleted duplicate comment " + dup.id); }
  const shaOf = (c) => ((c.body.match(/^<!-- flows-pr-review ([0-9a-f]{40}) -->/) || [])[1]);
  if (existing && shaOf(existing) === headSha) { console.log("already posted for " + headSha); return; }
  let text = fs.readFileSync(bodyPath, "utf8");
  if (Buffer.byteLength(text) > 60000) text = Buffer.from(text).subarray(0, 60000).toString() + "\n\n_…truncated; the full review is in the run artifacts._\n";
  const body = marker + "\n" + text;
  if (!existing) { const c = await gh("POST", api + "/issues/" + number + "/comments", { body }); console.log("posted comment " + c.id + " for " + headSha); return; }
  // Overlapping wakes: a run for an older head must never overwrite a newer
  // verdict. Re-read right before writing; if the comment carries a commit
  // that is *ahead* of ours (GitHub's compare, so it works without local
  // history), the newer wake owns the comment and we leave it.
  const fresh = await gh("GET", api + "/issues/comments/" + existing.id);
  const current = shaOf(fresh) || "";
  if (current === headSha) { console.log("already posted for " + headSha); return; }
  if (current) {
    const cmp = await gh("GET", api + "/compare/" + headSha + "..." + current);
    if (cmp && cmp.status === "ahead") { console.log("comment already carries newer " + current + "; not overwriting with " + headSha); return; }
  }
  await gh("PATCH", api + "/issues/comments/" + existing.id, { body });
  console.log("updated comment " + existing.id + " for " + headSha);
})();
`;
async function postComment(f: Ctx, pr: Pr): Promise<void> {
  await f.run("cat > review/post.cjs <<'EOF'\n" + POST_SCRIPT + "\nEOF\n");
  await f.run(
    `node review/post.cjs ${shellWord(REPO.owner)} ${shellWord(REPO.repo)} ${shellWord(String(pr.number))} ${shellWord(pr.headSha)} ${shellWord(CONSENSUS)}`,
    { timeout: "2m" },
  );
}
type Ctx = Parameters<Parameters<typeof flow<PrReviewInput>>[2]>[0];
