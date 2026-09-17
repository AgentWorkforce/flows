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
// judgement is delegated to an agent, and it must return JSON.
import { flow } from "@relayflows/surface";

type Input = { repo: string; channel: string; staleDays?: number };
type Triage = { stale: { number: number; title: string; reason: string }[]; attention: { number: number; title: string; reason: string }[] };

export default flow<Input>("stale-issues", { budget: { dollars: 2, wallclock: "10m" }, tools: { slack: true } }, async (f, input) => {
  const staleDays = input.staleDays ?? 14;
  const issues = await f.run(
    `curl -sf -H "Authorization: Bearer $GH_TOKEN" "https://api.github.com/repos/${input.repo}/issues?state=open&per_page=100" ` +
    `| node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const now=Date.now();console.log(JSON.stringify(JSON.parse(s).filter(i=>!i.pull_request).map(i=>({number:i.number,title:i.title,labels:i.labels.map(l=>l.name),updatedDaysAgo:Math.floor((now-Date.parse(i.updated_at))/864e5),comments:i.comments}))))})'`,
    { timeout: "2m" },
  );
  const list = JSON.parse(issues) as { number: number; title: string; updatedDaysAgo: number }[];
  if (list.length === 0) return f.done("success");

  const triage = await f.llm(
    `Here are the open issues of ${input.repo} as JSON: ${issues}\n` +
    `An issue is stale if it has had no update for ${staleDays}+ days and no clear owner or next step. ` +
    `An issue needs attention if it is recent but blocked, unanswered, or contradicts another. ` +
    `Return JSON { stale: [{number,title,reason}], attention: [{number,title,reason}] }; keep reasons to one sentence.`,
    { output: { type: "object", required: ["stale", "attention"], properties: {
      stale: { type: "array" }, attention: { type: "array" } } } },
  ) as Triage;

  const line = (i: { number: number; title: string; reason: string }) =>
    `• <https://github.com/${input.repo}/issues/${i.number}|#${i.number}> ${i.title} — ${i.reason}`;
  const digest = [
    `*${input.repo}: ${list.length} open issues* (stale after ${staleDays} days)`,
    triage.stale.length ? `\n*Stale (${triage.stale.length})*\n${triage.stale.map(line).join("\n")}` : "\nNothing stale.",
    triage.attention.length ? `\n*Needs attention (${triage.attention.length})*\n${triage.attention.map(line).join("\n")}` : "",
  ].join("\n");

  await f.slack.post(input.channel, digest);
  f.done("success");
});
