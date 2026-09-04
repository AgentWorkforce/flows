// GREEN — a schedule reports success only when work actually executed.
//
// BUG      see cron-succeeded-into-void.red.flow.ts
// EVIDENCE packages/web/app/api/v1/workflows/schedules/trigger/route.ts:178-192;
//          runs 8e3e5916 and 740c3a27 (schedule flows-drive, 2026-08-27)
// UPSTREAM to file — cloud RelayCron
//
// Two phases, because the fix has two halves:
//   1. with no eligible worker, the trigger reports a distinct non-success state
//      (`no_executor`) — covenant 2's preflight: a trigger with no executor is
//      refused before the run starts, not blessed after it;
//   2. with a worker, it reports `succeeded` AND the run's journal shows steps.
//
// This flow FAILS while the bug is present (phase 1 sees `succeeded`) and PASSES
// once both halves hold.
//
// RUN-WHEN: gate-1, gate-2, gate-6
// DEPENDS-ON: enrollment-token-bearer-auth (phase 2 needs headless enrolment)

import { flow } from "@relayflows/surface";

const WORKSPACE = "50587328-441d-4acb-b8f3-dbe1b3c5de99";

export default flow(
  "regressions/cron-succeeded-into-void.green",
  {
    identity: "regressions/cron-succeeded-into-void",
    tools: { relayfile: ["agentworkforce-cloud"] },
    budget: "$0.20/run",
  },
  async (f) => {
    const schedule = await f.cloud.schedules
      .create({
        workspaceId: WORKSPACE,
        workflow: "regressions/noop",
        cron: "0 0 1 1 *",
        name: "regression-cron-green",
        as: "cli-bearer",
      })
      .gate((s) => s.id.length > 0, "a disposable schedule");

    // Phase 1 — no executor.
    await f.cloud.workers
      .list({ workspaceId: WORKSPACE, as: "cli-bearer" })
      .gate((w) => w.online.length === 0, "precondition: no executor");

    await f.cloud.schedules.fire({ scheduleId: schedule.id, as: "cli-bearer" });

    await f.cloud.schedules
      .get({ scheduleId: schedule.id, as: "cli-bearer" })
      .gate(
        (s) => s.lastTriggerStatus === "no_executor",
        "with no eligible worker the trigger names that condition",
      )
      .gate(
        (s) => s.lastTriggerStatus !== "succeeded",
        "and never claims success for work that could not start",
      )
      .gate(
        (s) => (s.lastTriggerError ?? "").length > 0,
        "and leaves an error a human can read",
      );

    // Phase 2 — a real executor. Enrolment is headless, which is why this flow
    // depends on cloud#3202 being fixed first.
    const enrolment = await f.cloud.workers.mintEnrollmentToken({
      workspaceId: WORKSPACE,
      name: "regression-cron-worker",
      as: "cli-bearer",
    });

    await f
      .run(
        `agent-relay cloud worker register --workspace ${WORKSPACE}` +
          ` --token-file ${enrolment.tokenPath} --name regression-cron-worker --json` +
          " && agent-relay cloud worker start --daemon",
      )
      .gate((out) => out.includes("daemon started"), "an executor now exists");

    await f.cloud.schedules.fire({ scheduleId: schedule.id, as: "cli-bearer" });

    const state = await f.cloud.schedules
      .get({ scheduleId: schedule.id, as: "cli-bearer" })
      .gate(
        (s) => s.lastTriggerStatus === "succeeded",
        "with an executor, succeeded is now truthful",
      );

    await f.cloud.runs
      .journal({ runId: state.lastTriggeredRunId ?? "", as: "cli-bearer" })
      .gate(
        (j) => j.steps.length > 0,
        "and succeeded is backed by a journal with executed steps",
      )
      .gate(
        (j) => j.steps.every((step) => step.completionReason !== null),
        "every step carrying a completionReason (AGENTS.md rule 4)",
      );

    await f.cloud.schedules.remove({ scheduleId: schedule.id, as: "cli-bearer" });
    return f.done("success");
  },
);
