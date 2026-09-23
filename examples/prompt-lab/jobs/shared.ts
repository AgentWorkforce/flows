// Steps more than one job uses: the typed model call, the write → QA loop,
// the Apricot engine run, and the gated test planner.
import type { Ctx } from "@relayflows/surface";
import { engine, planTests, type Ask, type Call } from "../prompts.ts";
import { failStep } from "../lib/lab.ts";
import { parseReply, schemaError } from "../lib/reply.ts";
import type { Output, Patient } from "../lib/types.ts";

export const MAX_ATTEMPTS = 3;

const JSON_ONLY = "\n\nReply with the JSON object only: no prose before or after it, no markdown code fences.";
export const REPLY_ATTEMPTS = 2;

/**
 * One structured model call. The reply is journaled as text and checked here
 * against the call's JSON Schema; an invalid reply is re-asked once, naming
 * the error, then fails the run with it.
 *
 * Not f.llm's `output` option: relayflows 2.0.29 verifies the raw reply, so a
 * model that wraps valid JSON in a markdown fence fails the step, and a failed
 * run cannot be resumed (evidence/runtime-findings/00-job1-attempt1-fenced-json.txt, evidence/runtime-findings/00-patient-attempt1-fenced-json.txt).
 * The text form takes no model option, so calls use the CLI adapter's default.
 * Return to f.llm(prompt, { output, model }) once flows#558 ships.
 */
export async function llm<T>(f: Ctx, call: Call): Promise<T> {
  let problem = "";
  for (let attempt = 1; attempt <= REPLY_ATTEMPTS; attempt++) {
    const retry = problem ? `\n\nYour previous reply was rejected: ${problem}. Reply again.` : "";
    const text = await f.llm`${call.prompt}${JSON_ONLY}\nIt must match this JSON Schema:\n${JSON.stringify(call.output)}${retry}`;
    try {
      const value = parseReply(text);
      problem = schemaError(call.output, value) ?? "";
      if (!problem) return value as T;
    } catch (error) {
      problem = `not JSON (${error instanceof Error ? error.message : String(error)})`;
    }
  }
  return failStep(f, `model reply refused after ${REPLY_ATTEMPTS} attempts: ${problem}`);
}

interface Qa { pass: boolean; findings: string[] }

/**
 * Write, then QA, looping with QA's findings until a pass. Bounded: after
 * MAX_ATTEMPTS the caller parks the run for a human instead of shipping an
 * uncompliant prompt or chart.
 */
export async function untilQaPasses<T>(
  f: Ctx,
  write: (findings: readonly string[]) => Call,
  qa: (written: T) => Call | string[],
): Promise<{ value: T; passed: boolean; findings: string[] }> {
  let findings: string[] = [];
  let value!: T;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    value = await llm<T>(f, write(findings));
    const check = qa(value);
    const verdict: Qa = Array.isArray(check) ? { pass: check.length === 0, findings: check } : await llm<Qa>(f, check);
    // A pass with findings is not a pass.
    findings = verdict.pass && verdict.findings.length === 0 ? [] : verdict.findings.length ? verdict.findings : ["QA failed without findings"];
    if (findings.length === 0) return { value, passed: true, findings };
  }
  return { value, passed: false, findings };
}

/**
 * Run one prompt on fake visits: the same engine nurses use. One llm step per patient.
 *
 * Sequential on purpose. Every model call in this flow is independent and was
 * written as Promise.all, but relayflows 2.0.29 loses the run when concurrent
 * f.llm calls queue past their 30s lease (a stale completion becomes a fatal
 * protocol_error): see evidence/runtime-findings/runtime-parallel-llm-repro.txt. Restore
 * Promise.all here and in jobs/new-agency.ts when flows#561 and flows#560 ship.
 */
export async function runEngine(f: Ctx, promptText: string, ask: Ask, patients: readonly Patient[]): Promise<Record<string, Output>> {
  const outputs: Record<string, Output> = {};
  for (const p of patients) outputs[p.id] = await llm<Output>(f, engine(promptText, ask, p));
  return outputs;
}

export interface Plan { coverage: { questionId: string; patientIds: string[] }[]; gaps: { questionId: string; brief: string }[] }

/** Test QA, deterministic: every question exactly once, covered by real shelf patients or a gap brief. */
export function planError(plan: Plan, questionIds: readonly string[], shelf: readonly Patient[]): string | null {
  const onShelf = new Set(shelf.map((p) => p.id));
  const seen = [...plan.coverage.map((c) => c.questionId), ...plan.gaps.map((g) => g.questionId)];
  for (const q of questionIds) if (seen.filter((s) => s === q).length !== 1) return `question ${q} must appear exactly once`;
  if (seen.length !== questionIds.length) return "plan names a question that was not asked";
  for (const c of plan.coverage) for (const p of c.patientIds) if (!onShelf.has(p)) return `${p} is not on the shelf`;
  return null;
}

/** The test planner picks from the existing shelf; it never invents a patient per question. */
export async function planCoverage(f: Ctx, asks: readonly (Ask & { id: string })[], shelf: readonly Patient[]): Promise<Plan> {
  const plan = await llm<Plan>(f, planTests(asks, shelf));
  const why = planError(plan, asks.map((a) => a.id), shelf);
  if (why) await failStep(f, `test plan refused: ${why}`);
  return plan;
}
