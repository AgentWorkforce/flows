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
//     --input '{"approver":"you","issue":{"source":"linear","title":"…","body":"…","labels":[]}}'
import { flow } from "@relayflows/surface";

type Issue = { source: string; title: string; body: string; labels: string[]; url?: string };
type Input = { issue: Issue; approver: string };

// Every deterministic step runs under /bin/sh. Ticket text is attacker-
// controlled input, so it never reaches a command unquoted: `shellWord` is
// the one way a string becomes a shell argument here.
const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

// Flow artifacts live outside the repository's tracked tree, so `git add -A`
// cannot pick them up and a stale verdict from a previous run cannot survive.
const WORK = ".relayflow";

// The test command is a deterministic step: the agent never reports its own
// test result, the exit code does. Skips honestly when there is nothing to run.
const TEST = 'if [ -f package.json ] && node -e \'p=require("./package.json");process.exit(p.scripts&&p.scripts.test?0:1)\'; then npm ci --no-audit --no-fund && npm test; else echo "no test script; skipping"; fi';

export default flow<Input>("software-factory", { budget: { dollars: 10, wallclock: "1h" } }, async (f, input) => {
  const { issue } = input;
  if (!issue?.title?.trim()) {
    // Parked, not canceled: a body cannot declare a kernel outcome, and the
    // printed reason is what a human reads on the parked run.
    await f.run("echo 'Stopped: no ticket arrived with this run.' >&2");
    return f.done("needs_human");
  }
  const title = issue.title.trim().slice(0, 200);
  const ticket = `${issue.title}\n\n${issue.body ?? ""}${issue.url ? `\n\n${issue.url}` : ""}`;

  // Fresh work dir, excluded from git, no leftover verdicts.
  await f.run(`rm -rf ${WORK} && mkdir -p ${WORK} && { grep -qxF '${WORK}/' .git/info/exclude 2>/dev/null || echo '${WORK}/' >> .git/info/exclude; }`);

  await f.agent("implementer", {
    cli: "claude",
    // Continue from the journaled dirty workspace only for a classified
    // transport loss; an ordinary nonzero CLI exit remains terminal.
    transportRetries: 1,
    recoveryMode: "inspect",
    task: `Implement this ticket in the current repository, on the current branch, with regression tests. Commit as you go.\n` +
      `Write a PR description to ${WORK}/summary.md (what changed, how it was verified). Do not touch ${WORK}/ otherwise.\n\nTicket:\n${ticket}`,
  }).gate({ type: "subprocess_gate", command: `test -s ${WORK}/summary.md` });

  await f.run(TEST, { timeout: "15m" });

  // Adversarial review: a fresh agent tries to break the change. It may fix
  // what it finds; it must end with an explicit verdict file, not prose.
  await f.agent("adversary", {
    cli: "claude",
    transportRetries: 1,
    recoveryMode: "inspect",
    task: `Review the diff against the base branch as an adversary: find bugs, missing tests, unsafe defaults, and scope creep. ` +
      `Fix what is mechanical and re-run the tests. Write ${WORK}/review.md with your findings, then write ${WORK}/review.passed ` +
      `ONLY if the change is ready for a human to merge; otherwise write ${WORK}/review.blocked with the blocking findings.`,
  }).gate({ type: "subprocess_gate", command: `test -s ${WORK}/review.md` });

  await f.run(TEST, { timeout: "15m" });

  // Passed means exactly one verdict, and it is the pass marker.
  const verdict = await f.run(`if [ -f ${WORK}/review.passed ] && [ ! -f ${WORK}/review.blocked ]; then echo PASSED; else echo BLOCKED; fi`);
  await f.run("git add -A && (git diff --cached --quiet || git commit -qm 'Software factory: implementation and review fixes')");
  await f.run("git push --set-upstream origin HEAD");

  // Deterministic step, not an agent decision: the PR is opened either way,
  // but a blocked review opens it as a draft with the findings attached.
  if (verdict.trim() === "PASSED") {
    await f.run(`gh pr create --title ${shellWord(title)} --body-file ${WORK}/summary.md`);
    return f.done("success");
  }
  await f.run(`{ cat ${WORK}/summary.md; printf '\\n\\n## Adversarial review: BLOCKED\\n\\n'; cat ${WORK}/review.md; } > ${WORK}/pr-body.md`);
  await f.run(`gh pr create --draft --title ${shellWord(`[blocked] ${title}`)} --body-file ${WORK}/pr-body.md`);
  f.done("step_failed");
});
