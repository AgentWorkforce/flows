import { flow } from "@relayflows/surface";

type Issue = { source: string; title: string; body: string; labels: string[]; url?: string };
type Input = { issue: Issue; approver: string };

// Smoke deployment for `flows deploy`: one deterministic step, no agent.
export default flow<Input>("flows-cli-deploy-smoke", { budget: { wallclock: "5m" } }, async (f, input) => {
  // Issue text is external input: single-quote it (the SURFACE.md idiom) so
  // nothing from the title reaches /bin/sh unquoted.
  const shellWord = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
  await f.run(`printf '%s\n' ${shellWord(`issue: ${input.issue.title} labels=${input.issue.labels.join(",")}`)}`);
  f.done("success");
});
