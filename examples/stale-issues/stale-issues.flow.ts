// stale-issues — on a schedule, look at every open issue in a repository,
// decide which are stale or need attention, and post one Slack digest.
//
// Deploy on a schedule (flows schedule ships in the release after 2.0.16;
// until then run it locally or from any cron with `flows run --cloud`):
//   flows schedule examples/stale-issues/stale-issues.flow.ts \
//     --cron "0 9 * * 1-5" --tz Europe/Oslo \
//     --input '{"repo":"acme/api","channel":"#eng","staleDays":14}'
//
// The issue list is fetched deterministically (journaled, replayable); only the
// judgement is delegated to an LLM step, which must return schema-valid JSON.
import { flow } from "@relayflows/surface";

type Input = { repo: string; channel: string; staleDays?: number };
type Finding = { number: number; title: string; reason: string };
type Triage = { stale: Finding[]; attention: Finding[] };

const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;

// Follows GitHub's pagination (oldest-updated first) so a repository with more
// than 100 open issues is triaged in full; pull requests are dropped. Runs
// under node, not the shell: the repository name never touches /bin/sh
// unquoted, and it is validated before it gets here at all.
const FETCH_ISSUES = `node -e '
// Under node -e, argv[1] is "[eval]"; the repository is the last argument.

const repo = process.argv.at(-1);
const headers = { authorization: "Bearer " + process.env.GH_TOKEN, "user-agent": "relayflows-stale-issues", accept: "application/vnd.github+json" };
(async () => {
  const out = []; const now = Date.now();
  for (let page = 1; page <= 20; page++) {
    const res = await fetch("https://api.github.com/repos/" + repo + "/issues?state=open&sort=updated&direction=asc&per_page=100&page=" + page, { headers });
    if (!res.ok) { console.error("GitHub " + res.status); process.exit(1); }
    const batch = await res.json();
    for (const i of batch) if (!i.pull_request) out.push({ number: i.number, title: i.title, labels: i.labels.map(l => l.name), updatedDaysAgo: Math.floor((now - Date.parse(i.updated_at)) / 864e5), comments: i.comments });
    if (batch.length < 100) break;
  }
  console.log(JSON.stringify(out));
})();'`;

const FINDING_SCHEMA = {
  type: "object", required: ["number", "title", "reason"], additionalProperties: false,
  properties: { number: { type: "integer", minimum: 1 }, title: { type: "string", maxLength: 200 }, reason: { type: "string", maxLength: 300 } },
};

// Slack mrkdwn: text from the model is escaped so it cannot forge links,
// mentions or control sequences; links are built from the validated repo and
// integer issue number only.
const mrkdwn = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export default flow<Input>("stale-issues", { budget: { dollars: 2, wallclock: "10m" }, tools: { slack: true } }, async (f, input) => {
  if (!REPO.test(input.repo)) {
    await f.run("echo 'Stopped: repo must be owner/name.' >&2");
    return f.done("needs_human");
  }
  const staleDays = Math.max(1, Math.min(365, Math.trunc(input.staleDays ?? 14)));
  const issues = await f.run(`${FETCH_ISSUES} '${input.repo}'`, { timeout: "3m" });
  const list = JSON.parse(issues) as { number: number }[];
  if (list.length === 0) return f.done("success");
  const known = new Set(list.map(i => i.number));

  const triage = await f.llm(
    `Here are the open issues of ${input.repo} as JSON: ${issues}\n` +
    `An issue is stale if it has had no update for ${staleDays}+ days and no clear owner or next step. ` +
    `An issue needs attention if it is recent but blocked, unanswered, or contradicts another. ` +
    `Return JSON { stale: [{number,title,reason}], attention: [{number,title,reason}] }; keep reasons to one sentence.`,
    { output: { type: "object", required: ["stale", "attention"], additionalProperties: false, properties: {
      stale: { type: "array", maxItems: 50, items: FINDING_SCHEMA }, attention: { type: "array", maxItems: 50, items: FINDING_SCHEMA } } } },
  ) as Triage;

  // Only issues that were actually fetched can appear in the digest.
  const line = (i: Finding) =>
    `• <https://github.com/${input.repo}/issues/${i.number}|#${i.number}> ${mrkdwn(i.title)} — ${mrkdwn(i.reason)}`;
  const stale = triage.stale.filter(i => known.has(i.number));
  const attention = triage.attention.filter(i => known.has(i.number));
  const digest = [
    `*${mrkdwn(input.repo)}: ${list.length} open issues* (stale after ${staleDays} days)`,
    stale.length ? `\n*Stale (${stale.length})*\n${stale.map(line).join("\n")}` : "\nNothing stale.",
    attention.length ? `\n*Needs attention (${attention.length})*\n${attention.map(line).join("\n")}` : "",
  ].join("\n");

  await f.slack.post(input.channel, digest);
  f.done("success");
});
