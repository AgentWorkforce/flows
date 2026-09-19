// proof-helper-mount — a throwaway v2 flow proving cloud#3812 / cloud#3814:
// a deployment-launched authored run gets the relayfile GitHub mount for its
// repository, so `f.github.comment` lands on the PR through the journaled
// helper (exactly-once receipt), not through curl + GH_TOKEN.
//
//   flows deploy proof-helper-mount.flow.ts --name proof-helper-mount \
//     --on github:events=pull_request --repo AgentWorkforce/flows --agents claude
//
// Open a throwaway PR on AgentWorkforce/flows; the run posts one comment.
// Then close the PR and undeploy.

import { flow } from "@relayflows/surface";

interface Input {
  /** Present for a pull_request-launched run (cloud#3772). */
  pullRequest?: { owner: string; repo: string; number: number; headSha?: string; action?: string };
}

export default flow<Input>("proof-helper-mount", { budget: { dollars: 1, wallclock: "5m" } }, async (f, input) => {
  const pr = input.pullRequest;
  if (!pr) {
    f.done("success");
    return;
  }
  await f.github.comment(
    { owner: pr.owner, repo: pr.repo, number: pr.number },
    `proof-helper-mount: \`f.github.comment\` delivered through the relayfile GitHub mount ` +
      `(${pr.action ?? "event"} @ ${pr.headSha?.slice(0, 7) ?? "?"}).`,
  );
  f.done("success");
});
