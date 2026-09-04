// GREEN — cloud#3202: an org-owner CLI bearer can mint a usable enrolment token.
//
// BUG      see enrollment-token-bearer-auth.red.flow.ts
// EVIDENCE packages/web/app/api/v1/workers/enrollment-tokens/route.ts:113-115
// UPSTREAM cloud#3202
//
// This flow FAILS while the bug is present (the mint step is answered 403) and
// PASSES once bearer auth is accepted for org owners. It is the acceptance test:
// minting is not enough — the token must actually enrol a worker.
//
// RUN-WHEN: gate-1, gate-6, gate-8

import { flow } from "@relayflows/surface";

/** khaliq@agentrelay.com → workspace "Default". */
const WORKSPACE = "50587328-441d-4acb-b8f3-dbe1b3c5de99";

export default flow(
  "regressions/enrollment-token-bearer-auth.green",
  {
    identity: "regressions/cloud-3202",
    tools: { relayfile: ["agentworkforce-cloud"] },
    budget: "$0.05/run",
  },
  async (f) => {
    // The receipt carries a mount PATH, not the token: the mount write is the
    // effect record (Appendix A rule 3), so no secret is journaled and no
    // secret reaches a command line.
    const enrolment = await f.cloud.workers
      .mintEnrollmentToken({
        workspaceId: WORKSPACE,
        name: "regression-green",
        as: "cli-bearer",
      })
      .gate(
        (r) => r.tokenPath.startsWith("mnt/"),
        "an org-owner CLI bearer must be able to mint — no browser session required",
      )
      .gate(
        (r) => Date.parse(r.expiresAt) > Date.now(),
        "and the minted token must still be live when it is handed over",
      );

    // Minting is worthless if the token cannot enrol. The token is read from the
    // mount by the CLI, never interpolated into the command.
    const worker = await f
      .run(
        `agent-relay cloud worker register --workspace ${WORKSPACE}` +
          ` --token-file ${enrolment.tokenPath} --name regression-green --json`,
      )
      .gate(
        (out) => typeof JSON.parse(out).workerId === "string",
        "the minted token must be usable by `worker register` — the whole point of minting",
      );

    // The enrolment must be real on the cloud side too, not just locally
    // recorded — a mint that produces an invisible worker is another void.
    await f.cloud.workers
      .list({ workspaceId: WORKSPACE, as: "cli-bearer" })
      .gate(
        (w) => w.all.some((entry) => entry.workerId === JSON.parse(worker).workerId),
        "and the enrolled worker is visible to the account that minted for it",
      );

    return f.done("success");
  },
);
