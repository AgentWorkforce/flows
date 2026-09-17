import { flow } from "@relayflows/surface";

type Issue = { source: string; title: string; body: string; labels: string[]; url?: string };
type Input = { issue: Issue; approver: string };

// Smoke deployment for `flows deploy`: one deterministic step, no agent.
export default flow<Input>("flows-cli-deploy-smoke", { budget: { wallclock: "5m" } }, async (f, input) => {
  await f.run(`printf '%s\n' ${JSON.stringify(`issue: ${input.issue.title} labels=${input.issue.labels.join(",")}`)}`);
  f.done("success");
});
