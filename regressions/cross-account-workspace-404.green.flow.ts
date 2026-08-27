// GREEN — not-found and forbidden are distinguishable, and each names its own
//         condition.
//
// BUG      see cross-account-workspace-404.red.flow.ts
// EVIDENCE AgentWorkforce/cloud
//          packages/web/app/api/v1/workers/enrollment-tokens/route.ts:29-32
//            (404 {"error":"Workspace not found"} — no code, no user message)
//          packages/web/components/workers/NewWorkerForm.tsx:91-92
//            (every non-ok response → "Check your workspace permissions")
// UPSTREAM to file — cloud
//
// The fix moves the user-facing message to the API, where the condition is
// actually known: each response carries a stable `code` and a `userMessage` the
// client renders verbatim, so a wrong account never reads as a role problem.
//
// This flow FAILS while the bug is present (no code, no userMessage) and PASSES
// once the two conditions are distinguishable.
//
// RUN-WHEN: gate-1, gate-6, gate-8 (three principals in one run)

import { flow } from "@relayflows/surface";
import { field, probe, readProbe } from "./probe.js";

/** khaliqgant@gmail.com → workspace "Default" — the other account's. */
const OTHER_ACCOUNT_WORKSPACE = "0fb35c2e-861f-4d44-848e-fa3f5a3e192e";

/** khaliq@agentrelay.com → workspace "Default" — this account's own. */
const OWN_ACCOUNT_WORKSPACE = "50587328-441d-4acb-b8f3-dbe1b3c5de99";

export default flow(
  "regressions/cross-account-workspace-404.green",
  {
    identity: "regressions/cross-account-workspace-404",
    tools: { relayfile: ["agentworkforce-cloud"] },
    budget: "$0.05/run",
  },
  async (f) => {
    // Wrong account: not found, and it says so.
    const notFound = await f
      .run(
        probe({
          method: "POST",
          path: "/api/v1/workers/enrollment-tokens",
          principal: "browser-session",
          json: { workspaceId: OTHER_ACCOUNT_WORKSPACE, name: "regression-green" },
        }),
      )
      .gate((out) => readProbe(out).status === 404, "a workspace of another account is not found")
      .gate(
        (out) => field(readProbe(out).body, "code") === "workspace_not_found",
        "carrying a stable code the client can branch on",
      )
      .gate(
        (out) => !String(field(readProbe(out).body, "userMessage") ?? "").includes("permission"),
        "and a message that does not blame permissions for a not-found condition",
      )
      .gate(
        (out) => String(field(readProbe(out).body, "userMessage") ?? "").length > 0,
        "the message the user reads comes from the API, which is the only place the condition is known",
      );

    // Right account, insufficient role: forbidden, and it says that instead.
    const forbidden = await f
      .run(
        probe({
          method: "POST",
          path: "/api/v1/workers/enrollment-tokens",
          principal: "browser-session-member",
          json: { workspaceId: OWN_ACCOUNT_WORKSPACE, name: "regression-green" },
        }),
      )
      .gate((out) => readProbe(out).status === 403, "an in-account non-owner is forbidden")
      .gate(
        (out) => field(readProbe(out).body, "code") === "insufficient_role",
        "with its own code",
      )
      .gate(
        (out) => String(field(readProbe(out).body, "userMessage") ?? "").includes("owner"),
        "and a message naming the role the caller lacks",
      );

    // The point of the whole pair: the two are not interchangeable.
    await f
      .run("printf ok")
      .gate(
        () => field(readProbe(notFound).body, "code") !== field(readProbe(forbidden).body, "code"),
        "404 and 403 must be distinguishable by the client without guessing",
      );

    return f.done("bug_fixed");
  },
);
