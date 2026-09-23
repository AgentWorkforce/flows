// Prompt Lab — the inbox and workbench for writing and fixing the prompts that
// draft home-health charts, as one relayflow (docs/SURFACE.md dialect).
// The product brief is the spec; each job file maps its flow diagram line by
// line: "System" boxes are deterministic steps or model calls, "You" boxes are
// `f.human` gates asked of `input.reviewer`, "Outcome" boxes are lab writes.
//
//   job "new-agency"  Job 1: stand up an agency's first-pass prompts
//   job "fix"         Job 2: fix one shared or agency prompt from an issue or the picker
//   job "patient"     grow the locked shelf from a gap brief on the manager queue
//
// Apricot is stood in for by a local lab directory (see store.ts): bank.json is
// its Bank, and the chart-filling engine is an `llm` step given the live prompt.
//
//   flows run prompt-lab.flow.ts --local-agent \
//     --input '{"job":"new-agency","reviewer":"<you>","lab":"<dir>","agency":"sunrise","visitType":"soc"}'
import { flow } from "@relayflows/surface";
import { lab } from "./lib/lab.ts";
import { fix, type FixInput } from "./jobs/fix.ts";
import { newAgency, type NewAgencyInput } from "./jobs/new-agency.ts";
import { createPatient, type PatientInput } from "./jobs/patient.ts";

type Input = { reviewer: string; lab: string } & (
  | ({ job: "new-agency" } & NewAgencyInput)
  | ({ job: "fix" } & FixInput)
  | ({ job: "patient" } & PatientInput)
);

export default flow<Input>("prompt-lab", async (f, input) => {
  // Every "You" gate is asked of the reviewer the caller names; there is no default person.
  if (typeof input?.reviewer !== "string" || !input.reviewer.trim() || typeof input.lab !== "string" || !input.lab.trim()) {
    await f.run("echo 'Refused: input needs reviewer (who answers the gates) and lab (the lab directory).' >&2");
    return f.done("declined");
  }
  const job = { f, lab: lab(f, input.lab), labDir: input.lab, reviewer: input.reviewer };
  if (input.job === "new-agency") return newAgency(job, input);
  if (input.job === "fix") return fix(job, input);
  if (input.job === "patient") return createPatient(job, input);
  await f.run(`echo 'Refused: job must be new-agency, fix or patient.' >&2`);
  return f.done("declined");
});
