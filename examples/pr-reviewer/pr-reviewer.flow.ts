// pr-reviewer — the wepost-no/agents `review/agent.ts` PR reviewer, ported to
// a v2 relayflow (docs/SURFACE.md dialect).
//
// The v4 agent ran one harness prompt and relied on the surrounding platform
// for everything the prompt could not be trusted with: cloud materialized the
// checkout and `.workforce/pr.diff`, cloud committed and pushed whatever the
// agent left in the tree, and the prompt begged the agent not to lie about
// tests. Here every one of those becomes a journaled step the agent cannot
// forge:
//
//   PR state         → `f.run` + curl against the GitHub API, parsed in TS
//   checkout + diff  → `f.run` git commands
//   the review       → ONE `f.agent` step, gated on the review file existing
//   verification     → `f.run` runs the repo's tests OUTSIDE the agent; the
//                      exit code is the kernel's, so a red run cannot be
//                      talked into green
//   push / comment / → deterministic `f.run` git and the journaled
//   merge              `f.github` helper effects (exactly-once receipts)
//
// The v4 harness-retry-on-OOM, exit-code diagnostics and log plumbing are not
// ported: the kernel owns retries and leases, and the journal is the log.
//
// One file on purpose. Cloud (`flows run --cloud --sync-code`, `flows deploy`)
// receives a single authored source and does not resolve sibling imports, so
// the pure functions live below the flow and are exported for the tests.
//
// TODO(flows#434 follow-up): once the `artifact_exists` named gate lands,
// replace the `subprocess_gate` on the review step with
// `.gate({ type: "artifact_exists", path: REVIEW_FILE })`.
//
// Not yet wired, deliberately: the `check_run.completed` (merge-on-green) and
// `issue_comment.created` (`@relay fix conflicts`) events are not in the
// generated trigger vocabulary (`@relayflows/surface/triggers/github` has
// issues, pull_request, pull_request_review, push). Their decision logic is
// ported (`evaluateMergeOnGreenState`, `matchesConflictDirective`,
// `isAuthorizedConflictCommander`) and unit-tested, but nothing dispatches it.

import { flow, github } from "@relayflows/surface";

// ── input ───────────────────────────────────────────────────────────────────

export interface Input {
  owner: string;
  repo: string;
  number: number;
  /** Comma-separated GitHub logins whose approval merges the PR. Empty: any approval. */
  approvers: string;
  /** Comma-separated logins to review. Empty: review everyone. */
  reviewAuthors?: string;
  /** Comma-separated labels that turn the reviewer off. Default "no-agent-relay-review". */
  skipLabels?: string;
  /**
   * How GitHub writes reach GitHub. `helper` (default) is the journaled
   * `f.github` effect with an exactly-once receipt; it needs a relayfile
   * GitHub mount, which Cloud provides. `curl` posts through the REST API with
   * `$GH_TOKEN` from a deterministic step, for a local checkout with no mount.
   */
  githubTransport?: "helper" | "curl";
  /** The coding-agent CLI that writes the review. Default `claude`; `codex`, or a custom wrapper path. */
  reviewerCli?: string;
  /** A GitHub webhook payload, when this run was launched by one. */
  event?: unknown;
}

export const REVIEW_FILE = ".workforce/review.md";
export const DEFAULT_SKIP_LABEL = "no-agent-relay-review";

// ── the flow ────────────────────────────────────────────────────────────────

const reviewer = flow<Input>(
  "pr-reviewer",
  { budget: { dollars: 8, wallclock: "45m" } },
  async (f, input) => {
    const pr = prFromInput(input);
    const api = (path: string) =>
      f.run(`curl -sf -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" ${shellWord(`https://api.github.com/repos/${pr.owner}/${pr.repo}${path}`)}`);

    // An approval from an allowlisted approver ends the loop: merge and stop.
    if (input.event !== undefined && isApproval(input.event) && isAuthorizedApprover(input.approvers, input.event)) {
      const merged = await mergePullRequest(f, input, pr);
      // The journal is the log: record the outcome as a step, not stdout.
      await f.run(`printf '%s\\n' ${shellWord(merged ? `merged #${pr.number}` : `GitHub did not confirm the merge of #${pr.number}`)}`);
      return f.done(merged ? "success" : "step_failed");
    }

    // ── review gate: merged/closed, draft, disabling label, author allowlist ──
    const meta = JSON.parse(await api(`/pulls/${pr.number}`)) as PrMeta;
    const skip = shouldSkipReview(meta, pr, { skipLabels: input.skipLabels, reviewAuthors: input.reviewAuthors });
    if (skip) {
      // No work is an outcome. Not `canceled`: that is a kernel fact a body
      // cannot declare (flows#436), and a declination reason is still open.
      await f.run(`printf '%s\\n' ${shellWord(`pr-reviewer skipped #${pr.number}: ${skip.reason}`)}`);
      return f.done("success");
    }
    const headRef = readString(meta.head?.ref) ?? `pull/${pr.number}/head`;
    const baseRef = readString(meta.base?.ref) ?? "main";

    // ── materialize what the agent reads: checkout at the PR head, the diff,
    // the metadata. All deterministic, all journaled. ──
    // The PR head goes into a named ref: `git checkout FETCH_HEAD` after a
    // two-ref fetch silently takes the FIRST ref, which is the base branch.
    await f.run(`git fetch --no-tags --depth=200 origin ${shellWord(`+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`)} ${shellWord(`+refs/pull/${pr.number}/head:refs/remotes/origin/pr-${pr.number}`)} && git checkout -q -B review ${shellWord(`origin/pr-${pr.number}`)}`, { timeout: "5m" });
    await f.run(`mkdir -p .workforce && git diff ${shellWord(`origin/${baseRef}`)}...HEAD > .workforce/pr.diff && git diff --name-only ${shellWord(`origin/${baseRef}`)}...HEAD > .workforce/changed-files.txt`);
    await f.run(`printf '%s' ${shellWord(JSON.stringify(reviewContext(meta, pr)))} > .workforce/context.json`);
    const comments = JSON.parse(await api(`/pulls/${pr.number}/comments?per_page=100`)) as unknown;
    const reviews = JSON.parse(await api(`/pulls/${pr.number}/reviews?per_page=100`)) as unknown;
    await f.run(`printf '%s' ${shellWord(JSON.stringify({ reviewComments: comments, reviews }))} > .workforce/threads.json`);

    // ── the review. One agent step, gated on the file it must write. ──
    await f
      .agent("review", {
        cli: input.reviewerCli ?? "claude",
        task: reviewHarnessPrompt(pr) + `\nWrite the review to ${REVIEW_FILE}. Read .workforce/threads.json for the existing bot and reviewer comments.`,
      })
      // TODO: `.gate({ type: "artifact_exists", path: REVIEW_FILE })` once flows#434's follow-up lands.
      .gate({ type: "subprocess_gate", command: `test -s ${REVIEW_FILE}` });

    // ── verification, outside the agent. The exit code is the kernel's. ──
    const verified = await f.run(
      `if ${HARNESS_RESOURCE_ENV_SHELL} npm test > .workforce/test.log 2>&1; then echo PASS; else echo FAIL; fi`,
      { timeout: "15m" },
    );
    // trimEnd before the sentinel check: `stripLastLine` on a trailing newline
    // would strip only the newline and leave READY in the posted body.
    let review = (await f.run(`cat ${REVIEW_FILE}`)).trimEnd();
    const harnessReady = lastLine(review) === "READY";
    if (harnessReady) review = stripLastLine(review).trimEnd();

    // `.workforce/` is the flow's scratch, never the PR's: stage everything,
    // then unstage it (an exclude pathspec exits 1 when the dir is gitignored).
    const changed = (await f.run(`git add -A && git reset -q -- .workforce && git diff --cached --name-only`)).trim();
    if (changed && verified.trim() === "PASS") {
      // Mechanical fixes, verified by the full test command, go to the PR.
      await f.run(`git -c user.name=Relayflow -c user.email=noreply@agentrelay.com commit -q -m "review: mechanical fixes" && git push origin ${shellWord(`HEAD:refs/heads/${headRef}`)}`, { timeout: "5m" });
    } else if (changed) {
      // An unverified push is worse than no push: discard, and say so.
      await f.run(`git reset -q && git checkout -- . && git clean -fdq -e .workforce`);
      review += "\n\n## Advisory\nThe reviewer's edits were discarded: the repository's test command was red in the review sandbox (see .workforce/test.log). The proposed changes are described above; nothing was pushed.";
    }

    // Only call it a human's turn when it actually is: the agent said READY,
    // the tests this flow ran were green (a signal the v4 agent never had),
    // and GitHub's live state agrees.
    const ready = harnessReady && verified.trim() === "PASS" && prReadyStateAllowsHumanReview(await readPrReviewState(api, pr));
    const body = ready ? `${review}\n\n:white_check_mark: This PR is ready for your review.` : review;
    await postComment(f, input, pr, body);
    f.done("success");
  },
);

// The trigger path, declared for when Cloud dispatches PR events to a flow
// (today it launches the default body with the issue-shaped input). Each
// handler reads the PR from the payload and runs the same body.
reviewer.on(github.pull_request("opened"), async (f) => { f.done("success"); });
reviewer.on(github.pull_request("synchronize"), async (f) => { f.done("success"); });
reviewer.on(github.pull_request_review({ action: "submitted" }), async (f) => { f.done("success"); });

export default reviewer;

// ── GitHub writes ───────────────────────────────────────────────────────────
// Kept outside the body on purpose: `flows check` discovers `f.github` by
// reading the body's source, and a checkout with no relayfile mount would be
// refused before running at all. Here the choice is made at run time by
// `githubTransport`, and the refusal (`helper_provider.mount_required`)
// arrives only if the helper is actually asked for without a mount.

type Ctx = Parameters<Parameters<typeof flow<Input>>[2]>[0];

async function postComment(f: Ctx, input: Input, pr: Pr, body: string): Promise<void> {
  if (input.githubTransport === "curl") {
    await f.run(`curl -sf -X POST -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" ${shellWord(`https://api.github.com/repos/${pr.owner}/${pr.repo}/issues/${pr.number}/comments`)} -d ${shellWord(JSON.stringify({ body }))} > /dev/null`);
    return;
  }
  await f.github.comment({ owner: pr.owner, repo: pr.repo, number: pr.number }, body);
}

async function mergePullRequest(f: Ctx, input: Input, pr: Pr): Promise<boolean> {
  if (input.githubTransport === "curl") {
    const out = await f.run(`curl -sf -X PUT -H "Authorization: Bearer $GH_TOKEN" -H "Accept: application/vnd.github+json" ${shellWord(`https://api.github.com/repos/${pr.owner}/${pr.repo}/pulls/${pr.number}/merge`)} -d ${shellWord(JSON.stringify({ merge_method: "squash", ...(pr.headSha ? { sha: pr.headSha } : {}) }))}`);
    return (JSON.parse(out) as { merged?: unknown }).merged === true;
  }
  const result = await f.github.mergePullRequest({
    owner: pr.owner, repo: pr.repo, number: pr.number, method: "squash", ...(pr.headSha ? { sha: pr.headSha } : {}),
  });
  return result.merged === true;
}

// ── PR state from the REST API (the v4 agent read the relayfile VFS) ────────

async function readPrReviewState(api: (path: string) => PromiseLike<string>, pr: Pr): Promise<PullRequestReadyState> {
  const meta = JSON.parse(await api(`/pulls/${pr.number}`)) as PrMeta;
  const headSha = readString(meta.head?.sha);
  const checks = headSha === undefined ? undefined
    : JSON.parse(await api(`/commits/${headSha}/check-runs?per_page=100`)) as { check_runs?: unknown };
  const reviews = JSON.parse(await api(`/pulls/${pr.number}/reviews?per_page=100`)) as unknown;
  if (headSha !== undefined) pr.headSha = headSha;
  return prReviewStateFromRest(meta, checks, reviews);
}

/** The same `PullRequestReadyState` the v4 gates consumed, built from REST responses. */
export function prReviewStateFromRest(meta: PrMeta, checks: { check_runs?: unknown } | undefined, reviews: unknown): PullRequestReadyState {
  const latestReviews = Array.isArray(reviews) ? reviews.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object") : [];
  const checkRuns = Array.isArray(checks?.check_runs) ? checks.check_runs : [];
  return {
    state: typeof meta.state === "string" ? meta.state : undefined,
    isDraft: meta.draft === true,
    // REST reports mergeability directly (null while GitHub computes it).
    mergeable: meta.mergeable === true ? "MERGEABLE" : meta.mergeable === false ? "CONFLICTING" : "UNKNOWN",
    mergeStateStatus: meta.draft === true ? "DRAFT"
      : typeof meta.mergeable_state === "string" ? meta.mergeable_state.toUpperCase() : undefined,
    labels: meta.labels,
    statusCheckRollup: checkRuns,
    latestReviews,
    reviewDecision: deriveReviewDecision(latestReviews),
    ...(readString(meta.head?.sha) ? { headRefOid: meta.head!.sha } : {}),
  };
}

// ── the pieces of the v4 agent that are pure, ported verbatim ───────────────

export interface Pr {
  owner: string;
  repo: string;
  number: number;
  url: string;
  author: string;
  headSha?: string;
  state?: string;
  merged?: boolean;
  draft?: boolean;
  labels?: unknown;
}

/** The REST pull request record. Read defensively: fields may be absent. */
export interface PrMeta {
  state?: string;
  merged?: boolean;
  draft?: boolean;
  mergeable?: boolean | null;
  mergeable_state?: string;
  author?: string | { login?: string };
  user?: { login?: string };
  labels?: unknown;
  head?: { sha?: string; ref?: string };
  base?: { ref?: string };
  html_url?: string;
  title?: string;
  body?: string | null;
  [key: string]: unknown;
}

export const MERGE_ON_GREEN_LABEL = "merge-on-green";
export const AGENT_WORKFORCE_ORG = "agentworkforce";

// The opt-in directive a commenter posts to ask for merge-conflict resolution.
// Accepts "@relay fix conflicts" / "@relay-bot resolve conflict" (case- and
// whitespace-insensitive). Deliberately narrow: it must be an explicit ask, not
// any mention, so an ordinary "there's a conflict here" comment never fires it.
const CONFLICT_DIRECTIVE_PATTERN = /@relay(?:-?bot)?\s+(?:fix|resolve)\s+conflicts?\b/i;

/**
 * Memory budget for the repo's own test command, sized against the sandbox
 * (8 GiB hard ceiling; held to ONE worker so a 4 GiB V8 heap fits with
 * headroom). Applied by the flow's `f.run` test step, not by the agent.
 */
export const HARNESS_RESOURCE_ENV: Record<string, string> = {
  NODE_OPTIONS: "--max-old-space-size=4096",
  VITEST_MAX_THREADS: "1",
  VITEST_MIN_THREADS: "1",
  TURBO_CONCURRENCY: "1",
  JEST_MAX_WORKERS: "1",
};
const HARNESS_RESOURCE_ENV_SHELL = Object.entries(HARNESS_RESOURCE_ENV).map(([k, v]) => `${k}=${shellWord(v)}`).join(" ");

export function prFromInput(input: Input): Pr {
  const fromEvent = input.event === undefined ? undefined : readPr(input.event);
  const owner = readString(input.owner) ?? fromEvent?.owner;
  const repo = readString(input.repo) ?? fromEvent?.repo;
  const number = Number.isInteger(input.number) ? input.number : fromEvent?.number;
  if (!owner || !repo || number === undefined || !/^[A-Za-z0-9-]{1,39}$/.test(owner) || !/^[A-Za-z0-9_.-]{1,100}$/.test(repo)) {
    throw new Error("pr-reviewer input needs owner, repo and an integer number (or a PR-shaped event).");
  }
  return fromEvent && fromEvent.number === number ? fromEvent
    : { owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}`, author: "unknown" };
}

function reviewContext(meta: PrMeta, pr: Pr): Record<string, unknown> {
  return {
    owner: pr.owner, repo: pr.repo, number: pr.number, url: readString(meta.html_url) ?? pr.url,
    title: meta.title, body: meta.body ?? "", author: resolveAuthorLogin(meta, pr),
    labels: labelNames(meta.labels), head: meta.head, base: meta.base, draft: meta.draft === true,
  };
}

// ── review gate ─────────────────────────────────────────────────────────────
// Decide whether to (re)review/fix this PR at all. Returns a skip reason, or
// null to proceed. Gates, in order: already-merged, draft, a disabling label,
// and an author allowlist.
export function shouldSkipReview(
  meta: PrMeta | undefined,
  pr: Pr,
  config: { skipLabels?: string | undefined; reviewAuthors?: string | undefined },
): { reason: string; notify?: boolean } | null {
  // Already merged/closed by the time we got here — don't post a stale review
  // on a finished PR.
  const state = (meta?.state ?? pr.state ?? "").trim().toLowerCase();
  if (meta?.merged === true || pr.merged === true || state === "closed") {
    return { reason: "PR is already merged/closed" };
  }
  // A draft PR is held by its author — they aren't asking for review yet, and an
  // auto-push into a work-in-progress branch is unwanted.
  if (meta?.draft === true || pr.draft === true) {
    return { reason: "PR is a draft" };
  }
  // A disabling label turns the reviewer off entirely for this PR.
  const skipLabels = skipLabelSet(config.skipLabels);
  const prLabels = labelNames(Array.isArray(meta?.labels) ? meta.labels : pr.labels);
  const hit = prLabels.find((name) => skipLabels.has(name));
  if (hit) {
    return { reason: `PR carries the "${hit}" label` };
  }
  // Author allowlist: when set, only review/fix PRs opened by those logins.
  // Fail closed when configured: an unresolvable author is skipped, not guessed.
  const allow = commaSet(config.reviewAuthors);
  const author = resolveAuthorLogin(meta, pr);
  return reviewAuthorAllowlistDecision(allow, author);
}

/** Lowercased PR author login, preferring the authoritative record (string or
 *  `{ login }`, or REST's `user.login`) and falling back to the webhook payload. */
export function resolveAuthorLogin(meta: PrMeta | undefined, pr: Pr): string {
  const fromMeta = typeof meta?.author === "string" ? meta.author : meta?.author?.login ?? meta?.user?.login;
  return (fromMeta ?? pr.author ?? "").trim().toLowerCase();
}

/** Lowercased label names that disable the reviewer. Defaults to
 *  "no-agent-relay-review" when unset. */
export function skipLabelSet(raw: string | undefined): Set<string> {
  return commaSet(raw ?? DEFAULT_SKIP_LABEL);
}

function commaSet(raw: string | undefined): Set<string> {
  return new Set((raw ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
}

export function reviewAuthorAllowlistDecision(
  allow: Set<string>,
  author: string,
): { reason: string; notify?: boolean } | null {
  if (allow.size === 0) {
    return null;
  }
  if (!author || author === "unknown") {
    return { reason: "REVIEW_AUTHORS is set but the PR author could not be resolved", notify: true };
  }
  if (!allow.has(author)) {
    return { reason: `author @${author} is not in REVIEW_AUTHORS` };
  }
  return null;
}

export function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  return labels
    .map((l) => (l && typeof (l as { name?: unknown }).name === "string" ? (l as { name: string }).name.trim().toLowerCase() : ""))
    .filter(Boolean);
}

/** Keep the tail: a heap-exhaustion stack lands at the END of the output. */
export function harnessOutputTail(value: unknown, limit = 4000): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= limit ? trimmed : trimmed.slice(-limit);
}

export function reviewHarnessPrompt(pr: { owner: string; repo: string; number: number }): string {
  return [
    `Review pull request #${pr.number} in ${pr.owner}/${pr.repo}. The PR code is checked out in the current directory.`,
    `Focus on the actual PR changes: read .workforce/pr.diff first, then .workforce/changed-files.txt and .workforce/context.json.`,
    `Use the checked-out repo to trace the impact of this diff across callers, types, tests, config, and related files.`,
    `Flag and fix breakage even when the affected file is outside the changed-file set, but do not do an unrelated full-repo audit.`,
    `Auto-edit only lint, formatting, spelling, typo, import-order, or other mechanical non-semantic changes.`,
    `Do not auto-edit semantic or safety-critical logic. For behavior changes, architecture changes, and any reviewer`,
    `request that needs human judgment, leave a clear suggestion or review comment instead of changing files.`,
    `If the PR already has a human review or approval, switch to suggestion/comment-only for everything except`,
    `obvious mechanical cleanup that cannot change runtime behavior.`,
    `Resolve failing CI checks by editing the code only when the fix is mechanical and non-semantic. Don't use git or the gh CLI; the flow commits`,
    `and pushes your file edits to the PR after this step, only if the repository's full test command passes. In your output, do not claim that fixes were pushed,`,
    `a GitHub review was submitted, or CI was verified; those are later steps that the flow reports separately.`,
    `Validate every finding — yours or another bot's — against the CURRENT checkout before editing: review comments`,
    `are often stale (already fixed by a later push). Reproduce the problem in the code as it is now, or skip it.`,
    `Make the smallest fix that addresses a demonstrated problem. Do not rewrite, restructure, or "harden" working`,
    `code beyond what the finding requires.`,
    `Never change semantic or safety defaults: do not turn fail-closed states into fail-open states such as`,
    `"timeout", "pending", throw, or undefined becoming "acked", true, {}, or another success/default path; do not`,
    `swap truthiness checks for presence checks; do not edit guard default values. If a reviewer asks for one of`,
    `these changes, explain the risk in your review and leave the code unchanged.`,
    `Never touch lifecycle, termination, reaper, in-flight, dispatch, broker ownership, or process-cleanup code. Those`,
    `areas are safety-critical; raise findings as comments for a human-authored patch instead.`,
    `Stay within this PR's purpose (.workforce/pr.diff is the change; use .workforce/context.json for available PR`,
    `metadata). A reviewer suggestion that changes files or behavior unrelated to`,
    `that purpose — refactoring a module`,
    `the PR doesn't touch, renaming resources in an adapter the PR never edits, a cross-cutting "while you're here"`,
    `cleanup — does NOT belong in this PR: record it as an advisory note under a "## Advisory Notes" heading in your review and leave the code unchanged.`,
    `Folding an unrelated change into the PR is how you break an unrelated package's build; when in doubt, scope out.`,
    `Account for every bot and reviewer comment explicitly in your output under an "## Addressed comments" heading:`,
    `one bullet per comment naming the bot/reviewer and what they raised, followed by either the file:line where you`,
    `fixed it (e.g. "fixed in src/foo.ts:42") or, if you did not change anything, a one-line reason (stale —`,
    `already handled by a later commit, or invalid because <reason>). This is how the comment authors and the human`,
    `see that each thread was handled and exactly where, so be specific with the path and line; do not say a comment`,
    `was addressed without pointing to the fix.`,
    `Verify every edit before you finish, and verify it the way CI does — not just the unit test next to the file.`,
    `Run the repo's canonical build and test command end to end (read package.json / turbo.json / the CI workflow to`,
    `find what CI actually runs, focusing only on build/test/typecheck steps; install dependencies if needed) so you catch breakage DOWNSTREAM of the file you`,
    `The sandbox is memory-constrained, so run those steps SERIALLY: do not raise worker/concurrency counts, and`,
    `prefer a tool's single-worker flag (e.g. --maxWorkers=1, --concurrency=1) when it has one. A build or test run`,
    `that is killed outright verifies nothing, so a slower serial run is strictly better than a parallel one that dies.`,
    `edited. In a monorepo, editing one source file can break a generated/committed artifact (a catalog, lockfile,`,
    `snapshot, or generated types) or a different package that imports it: when a finding makes you touch a source`,
    `that feeds a generated file, regenerate that file with the repo's own generator and rebuild the packages that`,
    `consume it. A green "tests for the file I touched" while the full build/test is red is exactly the failure that`,
    `ships — the working tree must pass the full command with your edits in place. When you change code that`,
    `GENERATES commands, scripts, or queries, also execute a sample of the generated output against a throwaway`,
    `fixture — tests that only assert on the generated string prove nothing about its behavior.`,
    `Never add or modify tests to make your own change pass. If a change needs a new or updated test, that is a`,
    `human decision; describe the needed test in your review and leave the working tree unchanged.`,
    `Never make a check pass by weakening the test: do not delete it, skip it, loosen an assertion, narrow its`,
    `inputs, or replace a real assertion with a trivially-true one. A test that no longer fails when the behavior it`,
    `guards regresses is worse than no test, and it passes CI while hiding the bug. When an edit makes a test fail,`,
    `fix the CODE; only change a test's EXPECTATION when the test encoded the OLD, now-intentionally-changed contract`,
    `and the new expected value is demonstrably correct — and say which in your "## Addressed comments" notes. If you`,
    `cannot make a test genuinely pass, leave the code unfixed and raise it as advisory rather than gutting the test.`,
    `If you cannot verify an edit (tests cannot run in this sandbox and you cannot make them run), do not leave it`,
    `in the working tree: discard it with "git restore <file>" — the one exception to the no-git rule, because`,
    `rewriting a file back from memory is error-prone — delete files you created, and present the proposed change as`,
    `advisory text in your review instead. Anything left in the working tree is committed and pushed to the PR after`,
    `you exit, if the full test command passes — an unverified push is worse than no push.`,
    `Only end your output with READY on its own last line when the PR genuinely needs a human now — meaning you have`,
    `resolved or addressed every bot and reviewer comment, every required CI check has completed (none are pending`,
    `or in-progress) and all are passing, the PR has no merge conflicts (GitHub reports it as mergeable), and the`,
    `remaining decision requires human judgment. If any check is still pending, in-progress, or failed, or if the PR`,
    `has merge conflicts, do NOT print READY.`,
  ].join("\n");
}

export function conflictResolveHarnessPrompt(pr: { owner: string; repo: string; number: number }): string {
  return [
    `Resolve the merge conflicts on pull request #${pr.number} in ${pr.owner}/${pr.repo}. The PR is checked out in the`,
    `current directory and the flow has already merged the base branch into the working tree, so conflict markers`,
    `(<<<<<<<, =======, >>>>>>>) are present in the conflicted files. Read .workforce/conflicted-files.txt for the`,
    `exact list, and .workforce/pr.diff plus .workforce/context.json to understand what this PR changed versus base.`,
    `Resolve EVERY conflict with the smallest correct merge that preserves BOTH sides' intent: understand what each`,
    `side changed and why, then combine them so neither change is silently dropped. Do not blindly pick one side.`,
    `Remove every conflict marker you resolve — leave no <<<<<<<, =======, or >>>>>>> behind in any file you touch.`,
    `Do NOT use git or the gh CLI. The flow finalizes the merge commit and pushes it to the PR after you exit; your job`,
    `is only to leave a correctly merged working tree. Do not claim the merge was committed or pushed — that is a`,
    `later step the flow reports separately.`,
    `Stay strictly within resolving the conflicts. Do not refactor, "harden", or fold in unrelated changes while`,
    `merging — a conflict resolution that smuggles in extra edits is how an unrelated build breaks.`,
    `Never resolve a conflict by changing a semantic or safety default: do not turn a fail-closed state into a`,
    `fail-open one (a "timeout"/"pending"/throw/undefined becoming "acked"/true/{}/a success path), do not swap a`,
    `truthiness check for a presence check, and do not alter guard default values to make the merge simpler.`,
    `Never touch lifecycle, termination, reaper, in-flight, dispatch, broker ownership, or process-cleanup code to`,
    `resolve a conflict; if the conflict is in one of those areas, treat it as needing human judgment (below).`,
    `Never weaken or delete a test to resolve a conflict: do not skip it, loosen an assertion, or replace a real`,
    `assertion with a trivially-true one. When both sides changed a test, merge both expectations honestly.`,
    `If a conflict genuinely needs human judgment — the two sides are semantically incompatible, combining them is`,
    `ambiguous or risky, or it lands in safety-critical code — do NOT guess. Leave that file's conflict markers in`,
    `place, and list the file under a "## Unresolved conflicts" heading with a one-line reason. The flow aborts the`,
    `merge and posts your explanation when any conflict is left unresolved, so a risky half-merge is never pushed.`,
    `After resolving, verify the merged tree the way CI does — run the repo's canonical build/test/typecheck command`,
    `end to end (read package.json / turbo.json / the CI workflow to find what CI runs; install dependencies if`,
    `needed) so you catch breakage caused by combining the two sides, not just within one conflicted file. If you`,
    `cannot make the merged tree pass and cannot fix it without human judgment, leave the remaining markers and`,
    `record them under "## Unresolved conflicts" rather than pushing an unverified merge.`,
    `Account for every conflicted file in your output: list each resolved file under a "## Resolved conflicts"`,
    `heading with a one-line note on how you combined the two sides (e.g. "src/foo.ts — kept base's retry plus the`,
    `PR's new timeout arg"), and list any you left for a human under "## Unresolved conflicts".`,
  ].join("\n");
}

export interface PullRequestReadyState {
  state?: unknown;
  isDraft?: unknown;
  labels?: unknown;
  mergeable?: unknown;
  mergeStateStatus?: unknown;
  reviewDecision?: unknown;
  reviewRequests?: unknown;
  latestReviews?: unknown;
  statusCheckRollup?: unknown;
  headRefOid?: unknown;
  url?: unknown;
}

/** The adapter's per-PR aggregated check status (v4 VFS `checks/_summary.json`). */
export interface CheckSummary {
  total?: number;
  passed?: number;
  failed?: number;
  pending?: number;
  conclusion?: string;
}

/**
 * Turn the adapter's aggregated check counts into the statusCheckRollup shape
 * the gate evaluators already understand. Kept for the trigger path, where a
 * webhook payload carries counts rather than check runs.
 */
export function rollupFromCheckSummary(summary: CheckSummary | undefined): Array<Record<string, unknown>> {
  const failed = typeof summary?.failed === "number" ? summary.failed : 0;
  const pending = typeof summary?.pending === "number" ? summary.pending : 0;
  const passed = typeof summary?.passed === "number" ? summary.passed : 0;
  const total = typeof summary?.total === "number" ? summary.total : failed + pending + passed;
  if (!summary || total === 0) return [];
  const rollup: Array<Record<string, unknown>> = [];
  if (failed > 0) {
    rollup.push({ name: `${failed} failing check${failed === 1 ? "" : "s"}`, status: "COMPLETED", conclusion: "FAILURE" });
  }
  if (pending > 0) {
    rollup.push({ name: `${pending} pending check${pending === 1 ? "" : "s"}`, status: "IN_PROGRESS", conclusion: null });
  }
  if (failed === 0 && pending === 0) {
    rollup.push({ name: `${passed} check${passed === 1 ? "" : "s"}`, status: "COMPLETED", conclusion: "SUCCESS" });
  }
  return rollup;
}

/**
 * Derive gh's `reviewDecision` from the reviews: if any author's latest review
 * requested changes, the PR isn't the human's turn.
 */
export function deriveReviewDecision(reviews: Array<Record<string, unknown>>): string | undefined {
  for (const [, review] of latestReviewsByAuthor(reviews)) {
    if (normalizeState(review.state) === "CHANGES_REQUESTED") return "CHANGES_REQUESTED";
  }
  return undefined;
}

/** Whether the PR is still open. A missing `state` is treated as open. */
function prIsOpen(state: PullRequestReadyState): boolean {
  const s = normalizeState(state.state);
  return s === undefined || s === "OPEN";
}

export function prReadyStateAllowsHumanReview(state: PullRequestReadyState): boolean {
  // Never announce "ready for review" on a PR that merged or closed between the
  // review step and this check.
  if (!prIsOpen(state)) return false;
  // A draft PR isn't up for review yet.
  if (normalizeState(state.mergeStateStatus) === "DRAFT") return false;
  // No merge conflicts.
  if (state.mergeable !== "MERGEABLE") return false;
  // A reviewer or bot still asking for changes means it isn't the human's turn.
  if (normalizeState(state.reviewDecision) === "CHANGES_REQUESTED") return false;
  // Checks must all be complete and passing. An *empty* rollup is ambiguous:
  // only an empty rollup on a CLEAN PR counts as ready.
  const checks = Array.isArray(state.statusCheckRollup) ? state.statusCheckRollup : [];
  if (checks.length === 0) return normalizeState(state.mergeStateStatus) === "CLEAN";
  return checks.every(checkPassedAndComplete);
}

export type MergeOnGreenOutcome = "merged" | "ready" | "blocked" | "pending" | "skipped";

export interface MergeOnGreenGate {
  outcome: Exclude<MergeOnGreenOutcome, "merged" | "skipped">;
  reasons: string[];
}

export function mergeOnGreenRepoAllowed(pr: Pr): boolean {
  return pr.owner.trim().toLowerCase() === AGENT_WORKFORCE_ORG;
}

export function evaluateMergeOnGreenState(state: PullRequestReadyState): MergeOnGreenGate {
  const reasons: string[] = [];
  if (!prIsOpen(state)) reasons.push(`PR is ${String(state.state ?? "not open")}`);
  if (state.isDraft === true || normalizeState(state.mergeStateStatus) === "DRAFT") reasons.push("PR is a draft");
  if (!mergeOnGreenLabels(state.labels).has(MERGE_ON_GREEN_LABEL)) reasons.push(`PR is missing the "${MERGE_ON_GREEN_LABEL}" label`);
  if (state.mergeable === "CONFLICTING") reasons.push("PR has merge conflicts");
  const checkReason = mergeOnGreenChecksReason(state);
  if (checkReason) reasons.push(checkReason);
  const reviewReason = mergeOnGreenBotReviewReason(state);
  if (reviewReason) reasons.push(reviewReason);

  if (reasons.length === 0) return { outcome: "ready", reasons: [] };
  const blocked = reasons.some((reason) =>
    /fail|error|not passing|changes requested|requested changes|conflict|closed|merged|draft/i.test(reason),
  );
  return { outcome: blocked ? "blocked" : "pending", reasons };
}

function mergeOnGreenLabels(labels: unknown): Set<string> {
  return new Set(labelNames(labels));
}

function mergeOnGreenChecksReason(state: PullRequestReadyState): string | null {
  const checks = Array.isArray(state.statusCheckRollup) ? state.statusCheckRollup : [];
  if (checks.length === 0) {
    return normalizeState(state.mergeStateStatus) === "CLEAN"
      ? null
      : "checks are not reported as complete yet";
  }
  const blocked = checks.find((check) => !checkPassedAndComplete(check));
  if (!blocked || typeof blocked !== "object") return null;
  const record = blocked as Record<string, unknown>;
  const name = String(record.name ?? record.context ?? record.workflowName ?? "unknown");
  const stateText = String(record.state ?? record.status ?? "missing");
  const conclusionText = String(record.conclusion ?? "missing");
  if (stateText.toUpperCase() === "PENDING" || stateText.toUpperCase() === "IN_PROGRESS") {
    return `check "${name}" is still ${stateText.toLowerCase()}`;
  }
  if (stateText.toUpperCase() !== "COMPLETED" && record.status !== undefined) {
    return `check "${name}" is still ${stateText.toLowerCase()}`;
  }
  return `check "${name}" is not passing (${stateText}/${conclusionText})`;
}

function mergeOnGreenBotReviewReason(state: PullRequestReadyState): string | null {
  const latest = latestReviewsByAuthor(state.latestReviews);
  for (const [login, review] of latest) {
    const author = reviewAuthor(review);
    if (!isBotLogin(author.login, author.type)) continue;
    if (normalizeState(review.state) === "CHANGES_REQUESTED") {
      return `bot @${login} requested changes`;
    }
  }
  for (const login of requestedBotReviewLogins(state.reviewRequests)) {
    const review = latest.get(login);
    if (normalizeState(review?.state) !== "APPROVED") {
      return `bot @${login} has not approved yet`;
    }
  }
  return null;
}

function requestedBotReviewLogins(reviewRequests: unknown): string[] {
  if (!Array.isArray(reviewRequests)) return [];
  const logins = new Set<string>();
  for (const request of reviewRequests) {
    if (!request || typeof request !== "object") continue;
    const record = request as Record<string, unknown>;
    const reviewer = record.requestedReviewer && typeof record.requestedReviewer === "object"
      ? record.requestedReviewer as Record<string, unknown>
      : record;
    const login = readLogin(reviewer.login);
    const type = typeof reviewer.type === "string"
      ? reviewer.type
      : typeof reviewer.__typename === "string"
        ? reviewer.__typename
        : undefined;
    if (login && isBotLogin(login, type)) logins.add(login);
  }
  return [...logins].sort();
}

export function latestReviewsByAuthor(reviews: unknown): Map<string, Record<string, unknown>> {
  const latest = new Map<string, Record<string, unknown>>();
  if (!Array.isArray(reviews)) return latest;
  for (const review of reviews) {
    if (!review || typeof review !== "object") continue;
    const record = review as Record<string, unknown>;
    const author = reviewAuthor(record);
    if (!author.login) continue;
    const existing = latest.get(author.login);
    if (!existing || reviewTimestamp(record) >= reviewTimestamp(existing)) {
      latest.set(author.login, record);
    }
  }
  return latest;
}

function reviewAuthor(review: Record<string, unknown> | undefined): { login: string; type?: string } {
  if (!review) return { login: "" };
  const author = review.author && typeof review.author === "object"
    ? review.author as Record<string, unknown>
    : review.user && typeof review.user === "object"
      ? review.user as Record<string, unknown>
      : {};
  return {
    login: readLogin(author.login),
    type: typeof author.type === "string"
      ? author.type
      : typeof author.__typename === "string"
        ? author.__typename
        : undefined,
  };
}

function reviewTimestamp(review: Record<string, unknown>): number {
  const date = typeof review.submittedAt === "string"
    ? review.submittedAt
    : typeof review.submitted_at === "string"
      ? review.submitted_at
      : "";
  const ms = Date.parse(date);
  if (Number.isFinite(ms)) return ms;
  return typeof review.id === "number" ? review.id : 0;
}

function readLogin(value: unknown): string {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function isBotLogin(login: string, type?: string): boolean {
  return type === "Bot" || type === "BotUser" || login.endsWith("[bot]");
}

// A check that's complete and not blocking. SUCCESS and NEUTRAL pass; SKIPPED
// passes too — a conditionally-skipped job is GitHub's "not applicable".
function checkPassedAndComplete(check: unknown): boolean {
  if (!check || typeof check !== "object") return false;
  const record = check as Record<string, unknown>;
  const state = normalizeState(record.state);
  if (state) return state === "SUCCESS" || state === "NEUTRAL" || state === "SKIPPED";
  const status = normalizeState(record.status);
  const conclusion = normalizeState(record.conclusion);
  return status === "COMPLETED" && (conclusion === "SUCCESS" || conclusion === "NEUTRAL" || conclusion === "SKIPPED");
}

function normalizeState(value: unknown): string | undefined {
  return typeof value === "string" ? value.trim().toUpperCase() : undefined;
}

export function describeNotReadyState(state: PullRequestReadyState): string {
  if (!prIsOpen(state)) {
    return `state=${String(state.state ?? "missing")}`;
  }
  if (normalizeState(state.mergeStateStatus) === "DRAFT") {
    return "mergeStateStatus=DRAFT";
  }
  if (state.mergeable !== "MERGEABLE") {
    return `mergeable=${String(state.mergeable ?? "missing")}`;
  }
  if (normalizeState(state.reviewDecision) === "CHANGES_REQUESTED") {
    return "reviewDecision=CHANGES_REQUESTED";
  }
  const checks = Array.isArray(state.statusCheckRollup) ? state.statusCheckRollup : [];
  if (checks.length === 0) {
    return `no status checks reported and mergeStateStatus=${String(state.mergeStateStatus ?? "missing")} (not CLEAN)`;
  }
  const blocked = checks.find((check) => !checkPassedAndComplete(check));
  if (!blocked || typeof blocked !== "object") {
    return "statusCheckRollup contains a non-passing check";
  }
  const record = blocked as Record<string, unknown>;
  const name = record.name ?? record.context ?? record.workflowName ?? "unknown";
  const stateText = record.state ?? record.status ?? "missing";
  const conclusionText = record.conclusion ?? "missing";
  return `check=${String(name)} state=${String(stateText)} conclusion=${String(conclusionText)}`;
}

// ── parsing the github webhook payload ──────────────────────────────────────
// The PR lives in different places per event: `pull_request` (opened /
// synchronize / review / review_comment), `check_run.pull_requests[0]`
// (check_run.completed), `issue` (issue_comment.created — the issue IS the PR
// when `issue.pull_request` is present), or the top-level `number`.
export function readPr(payload: unknown): Pr | undefined {
  const p = payload as {
    number?: number;
    pull_request?: {
      number?: number;
      html_url?: string;
      user?: { login?: string };
      head?: { sha?: string };
      state?: string;
      merged?: boolean;
      draft?: boolean;
      labels?: unknown;
    };
    issue?: {
      number?: number;
      html_url?: string;
      user?: { login?: string };
      state?: string;
      draft?: boolean;
      labels?: unknown;
      pull_request?: unknown;
    };
    check_run?: { pull_requests?: Array<{ number?: number; html_url?: string; head_sha?: string }> };
    repository?: { name?: string; owner?: { login?: string } };
    sender?: { login?: string };
  } | null;
  const prIssue = p?.issue?.pull_request != null ? p.issue : undefined;
  const prRef = p?.pull_request ?? p?.check_run?.pull_requests?.[0] ?? prIssue;
  const number = prRef?.number ?? p?.number;
  const owner = p?.repository?.owner?.login;
  const repo = p?.repository?.name;
  if (typeof number !== "number" || !Number.isInteger(number) || !owner || !repo) return undefined;
  const headSha = p?.pull_request?.head?.sha ?? p?.check_run?.pull_requests?.[0]?.head_sha;
  const author =
    p?.pull_request?.user?.login ??
    prIssue?.user?.login ??
    ((p?.pull_request || prIssue) ? p?.sender?.login : undefined) ??
    "unknown";
  const state = p?.pull_request?.state ?? prIssue?.state;
  const draft = typeof p?.pull_request?.draft === "boolean" ? p.pull_request.draft : prIssue?.draft;
  const labels = p?.pull_request?.labels ?? prIssue?.labels;
  return {
    owner,
    repo,
    number,
    url: prRef?.html_url ?? `https://github.com/${owner}/${repo}/pull/${number}`,
    author,
    ...(headSha ? { headSha } : {}),
    ...(state ? { state } : {}),
    ...(typeof p?.pull_request?.merged === "boolean" ? { merged: p.pull_request.merged } : {}),
    ...(typeof draft === "boolean" ? { draft } : {}),
    ...(labels !== undefined ? { labels } : {}),
  };
}

/** The body of an issue_comment webhook, or '' when absent. */
export function commentBody(payload: unknown): string {
  const body = (payload as { comment?: { body?: unknown } } | null)?.comment?.body;
  return typeof body === "string" ? body : "";
}

/** The login of whoever wrote the comment (NOT the PR author), lowercased. */
export function commenterLogin(payload: unknown): string {
  const login = (payload as { comment?: { user?: { login?: unknown } } } | null)?.comment?.user?.login;
  return typeof login === "string" ? login.trim().toLowerCase() : "";
}

/** Whether a comment body carries the opt-in conflict-resolution directive. */
export function matchesConflictDirective(body: string): boolean {
  return CONFLICT_DIRECTIVE_PATTERN.test(body);
}

/**
 * Who may command a conflict resolution. A bot never qualifies, and when
 * approvers/reviewAuthors are configured the commenter must be the PR's own
 * author or appear on one of those lists. With neither list set, anyone.
 */
export function isAuthorizedConflictCommander(
  config: { approvers?: string | undefined; reviewAuthors?: string | undefined },
  commander: string,
  pr: Pr,
): boolean {
  if (!commander || commander.endsWith("[bot]")) return false;
  const approvers = [...commaSet(config.approvers)];
  const reviewAuthors = commaSet(config.reviewAuthors);
  if (approvers.length === 0 && reviewAuthors.size === 0) return true;
  if (commander === (pr.author ?? "").trim().toLowerCase()) return true;
  return approvers.includes(commander) || reviewAuthors.has(commander);
}

export function isApproval(payload: unknown): boolean {
  return (payload as { review?: { state?: string } } | null)?.review?.state?.toLowerCase() === "approved";
}

/** Honor approvals only from `approvers` (comma-separated logins). Unset: any approval merges. */
export function isAuthorizedApprover(approvers: string | undefined, payload: unknown): boolean {
  const allow = [...commaSet(approvers)];
  if (allow.length === 0) return true;
  const approver = (payload as { review?: { user?: { login?: string } } } | null)?.review?.user?.login?.toLowerCase();
  return approver !== undefined && allow.includes(approver);
}

/** A finished check run that didn't pass — failure, timed out, cancelled, etc. */
export function ciFailed(payload: unknown): boolean {
  const conclusion = (payload as { check_run?: { conclusion?: string } } | null)?.check_run?.conclusion?.toLowerCase();
  return conclusion !== undefined && conclusion !== "success" && conclusion !== "neutral" && conclusion !== "skipped";
}

// ── tiny helpers ────────────────────────────────────────────────────────────

export function lastLine(text: string): string {
  return text.trimEnd().split("\n").pop()?.trim() ?? "";
}

export function stripLastLine(text: string): string {
  const i = text.lastIndexOf("\n");
  return i < 0 ? "" : text.slice(0, i);
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

/** Quote one shell word; the only way author strings reach a command. */
export function shellWord(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
