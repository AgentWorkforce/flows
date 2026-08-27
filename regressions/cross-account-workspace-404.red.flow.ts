// RED — a not-found workspace is reported to the user as a permissions problem.
//
// BUG      Two accounts each own a workspace named "Default". Requesting the
//          other account's workspace answers 404 {"error":"Workspace not found"}
//          — a body with no machine-readable code and no user-facing message.
//          The client maps EVERY non-ok response to one string, so a wrong
//          account reads as a role problem and the user retries forever with
//          permissions they already have. Covenant 1: an error message must name
//          the author's mistake in the author's vocabulary.
// EVIDENCE AgentWorkforce/cloud
//          packages/web/app/api/v1/workers/enrollment-tokens/route.ts:29-32
//            response: NextResponse.json({ error: "Workspace not found" }, { status: 404 })
//          packages/web/components/workers/NewWorkerForm.tsx:91-92
//            if (!response.ok) {
//              setError("Could not create an enrollment token. Check your workspace permissions and try again.");
//          Observed 2026-08-27:
//            khaliq@agentrelay.com     → workspace 50587328-441d-4acb-b8f3-dbe1b3c5de99
//            khaliqgant@gmail.com      → workspace 0fb35c2e-861f-4d44-848e-fa3f5a3e192e
// UPSTREAM to file — cloud
//
// This flow PASSES while the bug is present.
//
// RUN-WHEN: gate-1, gate-6, gate-8 (two principals in one run)

import { flow } from "@relayflows/surface";
import { field, probe, readProbe } from "./probe.js";

/** khaliqgant@gmail.com → workspace "Default" — the other account's. */
const OTHER_ACCOUNT_WORKSPACE = "0fb35c2e-861f-4d44-848e-fa3f5a3e192e";

/** khaliq@agentrelay.com → workspace "Default" — this account's own. */
const OWN_ACCOUNT_WORKSPACE = "50587328-441d-4acb-b8f3-dbe1b3c5de99";

export default flow(
  "regressions/cross-account-workspace-404.red",
  {
    identity: "regressions/cross-account-workspace-404",
    tools: { relayfile: ["agentworkforce-cloud"] },
    budget: "$0.05/run",
  },
  async (f) => {
    await f
      .run(
        probe({
          method: "POST",
          path: "/api/v1/workers/enrollment-tokens",
          principal: "browser-session",
          json: { workspaceId: OTHER_ACCOUNT_WORKSPACE, name: "regression-red" },
        }),
      )
      .gate(
        (out) => readProbe(out).status === 404,
        "asking for another account's workspace is a not-found condition",
      )
      .gate(
        (out) => field(readProbe(out).body, "code") === undefined,
        "the bug: the body carries no code, so the client cannot tell 404 from 403",
      )
      .gate(
        (out) => field(readProbe(out).body, "userMessage") === undefined,
        "and no user-facing message, so the client invents one",
      );

    // The genuine role failure — an in-account member who is not an org owner —
    // answers a body of the same shape. Two different conditions, one
    // indistinguishable payload: that is why the client can only ever print one
    // message, and why the message it prints is the wrong one half the time.
    await f
      .run(
        probe({
          method: "POST",
          path: "/api/v1/workers/enrollment-tokens",
          principal: "browser-session-member",
          json: { workspaceId: OWN_ACCOUNT_WORKSPACE, name: "regression-red" },
        }),
      )
      .gate(
        (out) => readProbe(out).status === 403,
        "an in-account non-owner is a role condition",
      )
      .gate(
        (out) => field(readProbe(out).body, "code") === undefined,
        "and carries no code either — the client sees two failures it cannot tell apart",
      );

    return f.done("bug_reproduced");
  },
);
