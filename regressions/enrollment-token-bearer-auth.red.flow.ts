// RED — cloud#3202: worker enrollment cannot be automated.
//
// BUG      POST /api/v1/workers/enrollment-tokens gates on `requireSessionAuth`,
//          so a valid CLI bearer token is answered 403 Forbidden. There is no
//          headless, self-host, or CI path to enrol a worker — every worker must
//          be born from a browser session.
// EVIDENCE AgentWorkforce/cloud
//          packages/web/app/api/v1/workers/enrollment-tokens/route.ts:113-115
//            if (!requireSessionAuth(auth)) {
//              return NextResponse.json({ error: "Forbidden" }, { status: 403 });
//            }
//          Observed 2026-08-27: mint with `Authorization: Bearer <cli token>`
//          → HTTP 403 {"error":"Forbidden"}.
// UPSTREAM cloud#3202
//
// This flow PASSES while the bug is present — it is the executable bug report.
// Its green twin is the acceptance test.
//
// RUN-WHEN: gate-1, gate-6, gate-8

import { flow } from "@relayflows/surface";
import { field, probe, readProbe } from "./probe.js";

/** khaliq@agentrelay.com → workspace "Default". */
const WORKSPACE = "50587328-441d-4acb-b8f3-dbe1b3c5de99";

export default flow(
  "regressions/enrollment-token-bearer-auth.red",
  {
    identity: "regressions/cloud-3202",
    tools: { relayfile: ["agentworkforce-cloud"] },
    budget: "$0.05/run",
  },
  async (f) => {
    // The principal is an org owner holding a CLI bearer — the exact credential
    // `agent-relay login` already writes, and the only one a headless host has.
    await f
      .run(
        probe({
          method: "POST",
          path: "/api/v1/workers/enrollment-tokens",
          principal: "cli-bearer",
          json: { workspaceId: WORKSPACE, name: "regression-red" },
        }),
      )
      .gate(
        (out) => readProbe(out).status === 403,
        "the bug: a valid CLI bearer is refused, so enrolment has no headless path",
      )
      .gate(
        (out) => field(readProbe(out).body, "error") === "Forbidden",
        "and the refusal is the session-auth Forbidden from route.ts:114",
      );

    // Same request, same org owner, from a browser session: this one works.
    // The asymmetry is the whole bug, so the red case pins both halves.
    await f
      .run(
        probe({
          method: "POST",
          path: "/api/v1/workers/enrollment-tokens",
          principal: "browser-session",
          json: { workspaceId: WORKSPACE, name: "regression-red-session" },
        }),
      )
      .gate(
        (out) => readProbe(out).status === 200,
        "the same principal succeeds with a session cookie — only the bearer is refused",
      );

    return f.done("bug_reproduced");
  },
);
