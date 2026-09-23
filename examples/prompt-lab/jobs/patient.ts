// Set up a test patient (brief: "Test patient creator").
//
//   System  a gap brief from the test planner (or one you pass by hand)
//   System  agent writes the patient plan
//   You     may iterate the plan → kick generate (your last required action)
//   System  chart details → Patient QA loops until pass
//   Outcome lock onto the shelf → back to the manager
//
// You never approve the invented chart: Patient QA locks it.
import { hash8 } from "../lib/hash.ts";
import { shellWord } from "../lib/lab.ts";
import { identifiers } from "../lib/phi.ts";
import type { Patient } from "../lib/types.ts";
import { patientChart, patientPlan, patientQa } from "../prompts.ts";
import type { Job } from "./job.ts";
import { llm, MAX_ATTEMPTS, untilQaPasses } from "./shared.ts";

export interface PatientInput { briefId?: string; brief?: string; questionId?: string; visitType?: string }
type Chart = Omit<Patient, "locked" | "source">;

export async function createPatient(job: Job, input: PatientInput): Promise<void> {
  const { f, lab, reviewer } = job;
  const snap = await lab.snapshot();
  const queued = input.briefId ? snap.patientBriefs.find((b) => b.id === input.briefId && b.status === "queued") : undefined;
  if (input.briefId && !queued) throw new Error(`no queued patient brief ${input.briefId}`);
  const brief = queued?.brief ?? input.brief;
  const questionId = queued?.questionId ?? input.questionId;
  const visitType = queued?.visitType ?? input.visitType;
  if (!brief || !questionId || !visitType || !snap.bank.questions[questionId]) throw new Error("pass briefId, or brief + questionId + visitType");

  const { plan } = await llm<{ plan: string }>(f, patientPlan(brief, snap.bank.questions[questionId].text));
  // Keyed by the plan itself: a later run of the same brief gets its own file,
  // never the one an earlier, declined run left behind.
  const work = `work/patients/${queued?.id ?? `manual-${hash8(brief)}`}/${hash8(plan)}`;
  await lab.writeNew(`${work}/plan.json`, { brief, plan });

  const kick = await f.human(
    `Test patient creator · ${queued?.id ?? "manual brief"} for ${questionId} (${visitType} visit).\nPlan:\n${plan}\n` +
    `You may edit "plan" in ${job.labDir}/${work}/plan.json first.\n` +
    `yes = kick generate (Patient QA then locks it onto the shelf; you do not approve the chart); no = leave it on the queue.`,
    { to: reviewer });
  if (!kick) return f.done("declined");
  const final = await lab.read<{ brief: string; plan: string }>(`${work}/plan.json`, (v) =>
    typeof v?.plan === "string" && v.plan.trim().length > 0 ? null : "plan must be non-empty text");

  const taken = new Set(snap.shelf.map((p) => p.id));
  const made = await untilQaPasses<Chart>(f,
    (findings) => patientChart(brief, final.plan, visitType, findings),
    (chart) => {
      // Deterministic floor first: identifiers and id collisions never reach model QA.
      const hard = identifiers(`${chart.label} ${chart.referral} ${chart.notes}`);
      if (taken.has(chart.id)) hard.push(`id ${chart.id} is already on the shelf; pick another first-name label`);
      return hard.length ? hard : patientQa(brief, final.plan, chart);
    });
  if (!made.passed) {
    await f.run(`echo ${shellWord(`Patient QA did not pass after ${MAX_ATTEMPTS} charts: ${made.findings.join("; ")}`)} >&2`);
    return f.done("needs_human");
  }
  await lab.lockPatient(made.value, queued?.id);
  return f.done("success");
}
