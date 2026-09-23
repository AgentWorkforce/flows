// software-factory — a Linear (or GitHub/Jira/Shortcut) ticket becomes a pull
// request: an implementation agent, a deterministic test run, an adversarial
// review agent that must sign off, then the PR is opened for a human.
//
// Deploy (live in relayflows >= 2.0.16):
//   flows deploy examples/software-factory/software-factory.flow.ts \
//     --repo acme/api --on linear:team=ENG --approver you
//
// Cloud launches one run per matching ticket, cloned into a fresh
// relayflow/<name>-<id> branch of --repo, with { approver, issue, event } as
// the input. The same body runs locally from a checkout:
//   flows run software-factory.flow.ts --local-agent \
//     --input '{"approver":"you","issue":{"source":"linear","title":"…","body":"…","labels":[],"identifier":"ENG-42","url":"…"}}'
import { flow } from "@relayflows/surface";

type Issue = { source: string; title: string; body: string; labels: string[]; identifier?: string; url?: string };
type Input = { issue: Issue; approver: string };

// Every deterministic step runs under /bin/sh. Ticket text is attacker-
// controlled input, so it never reaches a command unquoted: `shellWord` is
// the one way a string becomes a shell argument here.
const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

// Flow artifacts live outside the repository's tracked tree, so `git add -A`
// cannot pick them up and a stale verdict from a previous run cannot survive.
const WORK = ".relayflow";

const PREPARE_CHANGE_METADATA = [
  `if [ ! -s ${WORK}/pr-body.md ]; then echo missing-body; exit 0; fi`,
  `if [ -n "$reference" ] && ! grep -qxF "$reference" ${WORK}/pr-body.md; then printf "\\n%s\\n" "$reference" >> ${WORK}/pr-body.md; fi`,
  "echo prepared",
].join("; ");

// Redundant with the TypeScript checks on purpose: this runs immediately
// before the first external effect and validates the final title/body bytes.
const VALIDATE_CHANGE_METADATA = [
  `if [ ! -s ${WORK}/pr-body.md ]; then echo missing-body`,
  "elif [ -z \"$title\" ]; then echo empty-title",
  "elif ! printf \"%s\\n\" \"$title_length\" | grep -Eq \"^[0-9]+$\"; then echo malformed-title-length",
  "elif [ \"$title_length\" -gt 240 ]; then echo title-too-long",
  "elif [ \"$(printf %s \"$title\" | tr \"[:upper:]\" \"[:lower:]\")\" = \"software factory change\" ] || [ \"$(printf %s \"$title\" | tr \"[:upper:]\" \"[:lower:]\")\" = \"replace with your ticket title\" ]; then echo placeholder-title",
  "elif [ \"$source\" = github ] && ! printf \"%s\\n\" \"$identifier\" | grep -Eq \"^#[1-9][0-9]*$\"; then echo malformed-github-identifier",
  `elif [ "$source" = github ]; then expected="Fixes $identifier"; count=$(grep -xcF "$expected" ${WORK}/pr-body.md || true); if [ "$count" -eq 0 ]; then echo missing-github-closing-reference; elif [ "$count" -ne 1 ]; then echo duplicate-github-closing-reference; else echo valid; fi`,
  "else echo valid",
  "fi",
].join("; ");

// The test command is a deterministic step: the agent never reports its own
// test result, the exit code does. Skips honestly when there is nothing to run.
const TEST = 'if [ -f package.json ] && node -e \'p=require("./package.json");process.exit(p.scripts&&p.scripts.test?0:1)\'; then npm ci --no-audit --no-fund && npm test; else echo "no test script; skipping"; fi';

export default flow<Input>("software-factory", {
  version: "2.0.22",
  hooks: ["pre-implement", "post-review", "merge-gate"],
  budget: { dollars: 10, wallclock: "1h" },
}, async (f, input) => {
  const { issue } = input;
  if (!issue || typeof issue.source !== "string" || !issue.source.trim() || typeof issue.title !== "string" || !issue.title.trim()) {
    // Parked, not canceled: a body cannot declare a kernel outcome, and the
    // printed reason is what a human reads on the parked run.
    await f.run("echo 'Stopped: no ticket arrived with this run.' >&2");
    return f.done("needs_human");
  }
  const normalizedTitle = issue.title.trim().replace(/\s+/g, " ");
  const title = Array.from(normalizedTitle).slice(0, 240).join("").trim();
  const titleLength = Array.from(title).length;
  const placeholderTitle = ["software factory change", "replace with your ticket title"]
    .includes(title.toLowerCase());
  const issueSource = issue.source.trim().toLowerCase();
  const issueIdentifier = typeof issue.identifier === "string" ? issue.identifier.trim() : "";
  const issueUrl = typeof issue.url === "string" ? issue.url.trim() : "";
  if (!title || placeholderTitle) {
    await f.run("echo 'Stopped: the pull-request title is empty or still a placeholder.' >&2");
    return f.done("needs_human");
  }
  if (issueSource === "github" && !/^#[1-9]\d*$/.test(issueIdentifier)) {
    await f.run("echo 'Stopped: a GitHub ticket must carry its normalized identifier in #<number> form.' >&2");
    return f.done("needs_human");
  }
  const changeReference = issueSource === "github"
    ? `Fixes ${issueIdentifier}`
    : issueSource === "gitlab" && /^#[1-9]\d*$/.test(issueIdentifier)
      ? `Closes ${issueIdentifier}`
      : issueUrl
        ? `Ticket: ${issueUrl}`
        : issueIdentifier
          ? `Ticket: ${issueIdentifier}`
          : "";
  const ticket = `${issue.title}\n\n${issue.body ?? ""}${issue.url ? `\n\n${issue.url}` : ""}`;

  const openPullRequest = async (bodyCommand: string, draft: boolean): Promise<boolean> => {
    await f.run(bodyCommand);
    await f.run(`reference=${shellWord(changeReference)}; ${PREPARE_CHANGE_METADATA}`);
    const metadata = (await f.run(
      `title=${shellWord(title)}; title_length=${titleLength}; source=${shellWord(issueSource)}; identifier=${shellWord(issueIdentifier)}; ${VALIDATE_CHANGE_METADATA}`,
    )).trim();
    if (metadata !== "valid") {
      await f.run(`echo ${shellWord(`Stopped: invalid pull-request metadata (${metadata}). No branch was pushed and no pull request was opened.`)} >&2`);
      return false;
    }
    await f.run("git push --set-upstream origin HEAD");
    await f.run(`gh pr create${draft ? " --draft" : ""} --title ${shellWord(title)} --body-file ${WORK}/pr-body.md`);
    return true;
  };

  // Fresh work dir, excluded from git, no leftover verdicts.
  await f.run(`rm -rf ${WORK} && mkdir -p ${WORK} && { grep -qxF '${WORK}/' .git/info/exclude 2>/dev/null || echo '${WORK}/' >> .git/info/exclude; }`);

  if (!await f.hook("pre-implement", { title, issue })) {
    await f.run("echo 'Stopped: pre-implement hook refused this ticket.' >&2");
    return f.done("declined");
  }

  await f.agent("implementer", {
    cli: "claude",
    task: `Implement this ticket in the current repository, on the current branch, with regression tests. Commit as you go.\n` +
      `Write a PR description to ${WORK}/summary.md (what changed, how it was verified). Do not touch ${WORK}/ otherwise.\n\nTicket:\n${ticket}`,
  }).gate({ type: "subprocess_gate", command: `test -s ${WORK}/summary.md` });

  await f.run(TEST, { timeout: "15m" });

  // Adversarial review: a fresh agent tries to break the change. It may fix
  // what it finds; it must end with an explicit verdict file, not prose.
  await f.agent("adversary", {
    cli: "claude",
    task: `Review the diff against the base branch as an adversary: find bugs, missing tests, unsafe defaults, and scope creep. ` +
      `Fix what is mechanical and re-run the tests. Write ${WORK}/review.md with your findings, then write ${WORK}/review.passed ` +
      `ONLY if the change is ready for a human to merge; otherwise write ${WORK}/review.blocked with the blocking findings.`,
  }).gate({ type: "subprocess_gate", command: `test -s ${WORK}/review.md` });

  await f.run(TEST, { timeout: "15m" });

  if (!await f.hook("post-review", { title })) {
    await f.run("git add -A && (git diff --cached --quiet || git commit -qm 'Software factory: implementation and review fixes')");
    if (!await openPullRequest(`{ cat ${WORK}/summary.md; printf '\\n\\n## post-review: blocked\\n\\n'; } > ${WORK}/pr-body.md`, true)) {
      return f.done("needs_human");
    }
    return f.done("step_failed");
  }

  // Passed means exactly one verdict, and it is the pass marker.
  const verdict = await f.run(`if [ -f ${WORK}/review.passed ] && [ ! -f ${WORK}/review.blocked ]; then echo PASSED; else echo BLOCKED; fi`);
  await f.run("git add -A && (git diff --cached --quiet || git commit -qm 'Software factory: implementation and review fixes')");

  // Deterministic step, not an agent decision: the PR is opened either way,
  // but a blocked review or a false merge-gate opens it as a draft.
  if (verdict.trim() === "PASSED") {
    const origin = (await f.run("git remote get-url origin")).trim();
    const headSha = (await f.run("git rev-parse HEAD")).trim();
    const matched = /github\.com[:/]([^/]+)\/([^/]+?)(?:\.git)?$/.exec(origin);
    const allowed = await f.hook("merge-gate", {
      owner: matched?.[1] ?? "",
      repo: matched?.[2] ?? "",
      headSha,
    });
    if (!allowed) {
      if (!await openPullRequest(`{ cat ${WORK}/summary.md; printf '\\n\\n## merge-gate: blocked\\n\\n'; } > ${WORK}/pr-body.md`, true)) {
        return f.done("needs_human");
      }
      return f.done("step_failed");
    }
    if (!await openPullRequest(`cp ${WORK}/summary.md ${WORK}/pr-body.md`, false)) {
      return f.done("needs_human");
    }
    return f.done("success");
  }
  if (!await openPullRequest(`{ cat ${WORK}/summary.md; printf '\\n\\n## Adversarial review: BLOCKED\\n\\n'; cat ${WORK}/review.md; } > ${WORK}/pr-body.md`, true)) {
    return f.done("needs_human");
  }
  f.done("step_failed");
});
