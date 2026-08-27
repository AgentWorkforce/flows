// RED — RelayCron reports `succeeded` for a schedule that executed nothing.
//
// BUG      The trigger route marks a fired schedule
//          `lastTriggerStatus: "succeeded"` as soon as the launch POST is
//          accepted and returns a runId. Acceptance is not execution: with no
//          worker enrolled the run is never claimed, so the schedule reports
//          success while producing no journal, no branch, no PR. A schedule can
//          be silently zero forever.
// EVIDENCE AgentWorkforce/cloud
//          packages/web/app/api/v1/workflows/schedules/trigger/route.ts:178-192
//            if (launchResponse.ok && typeof launchBody?.runId === "string") {
//              ... lastTriggerStatus: "succeeded"
//          Observed twice on 2026-08-27, schedule `flows-drive`:
//            runs 8e3e5916 and 740c3a27 — both `succeeded`, nothing executed.
//          RFC-0001 covenant 2: "a 'succeeded' that did nothing is by
//          definition a kernel bug".
// UPSTREAM to file — cloud RelayCron
//
// This flow PASSES while the bug is present. It uses its own disposable
// schedule so it never touches the production `flows-drive` schedule.
//
// RUN-WHEN: gate-1, gate-2, gate-6

import { flow } from "@relayflows/surface";

/** A workspace deliberately kept free of workers for this regression. */
const WORKSPACE = "50587328-441d-4acb-b8f3-dbe1b3c5de99";

export default flow(
  "regressions/cron-succeeded-into-void.red",
  {
    identity: "regressions/cron-succeeded-into-void",
    tools: { relayfile: ["agentworkforce-cloud"] },
    budget: "$0.05/run",
  },
  async (f) => {
    await f.cloud.workers
      .list({ workspaceId: WORKSPACE, as: "cli-bearer" })
      .gate(
        (w) => w.online.length === 0,
        "precondition: no executor exists, so nothing can possibly run",
      );

    const schedule = await f.cloud.schedules
      .create({
        workspaceId: WORKSPACE,
        workflow: "regressions/noop",
        cron: "0 0 1 1 *",
        name: "regression-cron-void",
        as: "cli-bearer",
      })
      .gate((s) => s.id.length > 0, "a disposable schedule — never the real flows-drive one");

    await f.cloud.schedules
      .fire({ scheduleId: schedule.id, as: "cli-bearer" })
      .gate((r) => r.accepted, "the sweep accepts the tick");

    const state = await f.cloud.schedules
      .get({ scheduleId: schedule.id, as: "cli-bearer" })
      .gate(
        (s) => s.lastTriggerStatus === "succeeded",
        "the bug: succeeded, with no executor anywhere in the system",
      )
      .gate(
        (s) => s.lastTriggerError === null,
        "and nothing was recorded that would let a human notice",
      );

    await f.cloud.runs
      .journal({ runId: state.lastTriggeredRunId ?? "", as: "cli-bearer" })
      .gate(
        (j) => j.steps.length === 0,
        "and the run it claims to have succeeded has no executed steps at all",
      );

    await f.cloud.schedules.remove({ scheduleId: schedule.id, as: "cli-bearer" });
    return f.done("bug_reproduced");
  },
);
