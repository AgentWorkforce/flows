// Every model call in Prompt Lab: the prompt it sends and the JSON Schema its
// answer must satisfy before the journal accepts it. Schemas are data, so the
// engine's answer enum IS the agency menu — on-menu is plumbing, not judgment.
import { CONFIDENCES, type Output, type Patient } from "./lib/types.ts";

export interface Ask { question: string; options: readonly string[] }
export interface Call { prompt: string; output: Record<string, unknown> }

const str = { type: "string", minLength: 1 };
const obj = (properties: Record<string, unknown>) =>
  ({ type: "object", additionalProperties: false, required: Object.keys(properties), properties });
const qaSchema = obj({ pass: { type: "boolean" }, findings: { type: "array", items: str } });
const promptSchema = obj({ prompt: { type: "string", minLength: 40 } });
const chart = (p: Patient): string => `REFERRAL PACKET:\n${p.referral}\n\nTODAY'S VISIT NOTES:\n${p.notes}`;
const briefBlock = (brief?: string): string => (brief ? `QUESTION BRIEF (success criteria):\n${brief}` : "QUESTION BRIEF: none (that is allowed).");

/** Apricot's chart-filling engine: the same prompt nurses' drafts come from. */
export function engine(promptText: string, ask: Ask, patient: Patient): Call {
  return {
    prompt: `You are the chart-filling engine for a home-health visit. Follow the INSTRUCTIONS exactly and nothing else.

INSTRUCTIONS:
${promptText}

QUESTION: ${ask.question}
OPTIONS (answer with exactly one): ${ask.options.join(" | ")}

${chart(patient)}

Return JSON: answer (one of the options), confidence (High, Medium or Low), explanation (one or two sentences citing the chart).`,
    output: obj({ answer: { enum: [...ask.options] }, confidence: { enum: [...CONFIDENCES] }, explanation: str }),
  };
}

/** First-pass prompt text: a v0 from question, options and type (and brief when one exists). */
export function firstPass(ask: Ask, guidelines: string, brief: string | undefined, findings: readonly string[]): Call {
  return {
    prompt: `Write the instruction text ("prompt") that tells a chart-filling engine how to answer one home-health assessment question from a visit chart. The engine is separately given the question, the options and the chart; your text is the reasoning rules.

QUESTION: ${ask.question}
OPTIONS: ${ask.options.join(" | ")}
TYPE: single choice

${briefBlock(brief)}

${guidelines}
${findings.length ? `\nA reviewer rejected the previous draft for:\n- ${findings.join("\n- ")}\nFix every point.` : ""}
Return JSON { "prompt": "<the instruction text>" }.`,
    output: promptSchema,
  };
}

/** Prompt QA: compliance with the brief (if any) plus the shared guidelines. Never "live" by itself. */
export function promptQa(promptText: string, ask: Ask, guidelines: string, brief: string | undefined): Call {
  return {
    prompt: `You are Prompt QA. Check this question prompt for compliance only: does it satisfy every shared guideline, and the question brief if there is one? Do not grade style.

QUESTION: ${ask.question}
OPTIONS: ${ask.options.join(" | ")}

PROMPT UNDER REVIEW:
${promptText}

${briefBlock(brief)}

${guidelines}

Return JSON { "pass": true|false, "findings": ["<each unmet guideline or brief criterion>"] }. pass is true only when findings is empty.`,
    output: qaSchema,
  };
}

export interface Change { patient: Patient; ai: Output; target: Output; notes: string }

/** The iterator: a rewrite function. Changeset + patients + brief + existing prompt in; new prompt text out. */
export function iterate(ask: Ask, existing: string, brief: string | undefined, changes: readonly Change[], findings: readonly string[]): Call {
  const rows = changes.map((c) => `--- ${c.patient.label}
${chart(c.patient)}
ENGINE SAID: ${c.ai.answer} / ${c.ai.confidence} / ${c.ai.explanation}
REVIEWER SAYS: ${c.target.answer} / ${c.target.confidence} / ${c.target.explanation}${c.notes ? `\nREVIEWER NOTES: ${c.notes}` : ""}`).join("\n\n");
  return {
    prompt: `Rewrite a home-health question prompt so the chart-filling engine produces the reviewer's answers on these charts. Change only the prompt text; the question brief and the reviewer's answers are fixed. Keep what already works; do not mention these specific patients.

QUESTION: ${ask.question}
OPTIONS: ${ask.options.join(" | ")}

EXISTING PROMPT:
${existing}

${briefBlock(brief)}

CHANGESET (every row the reviewer changed):
${rows}
${findings.length ? `\nPrompt QA rejected the previous rewrite for:\n- ${findings.join("\n- ")}\nFix every point.` : ""}
Return JSON { "prompt": "<the new instruction text>" }.`,
    output: promptSchema,
  };
}

/** Test planner: pick existing shelf patients so each question's paths can fire; queue briefs for holes. */
export function planTests(asks: readonly (Ask & { id: string })[], shelf: readonly Patient[]): Call {
  const patients = shelf.map((p) => `[${p.id}] ${p.label}, ${p.ageBand}\n${chart(p)}`).join("\n\n");
  const questions = asks.map((a) => `[${a.id}] ${a.question} Options: ${a.options.join(" | ")}`).join("\n");
  return {
    prompt: `You are the test planner for a home-health prompt workbench. For each question, pick the shelf patients whose charts contain real evidence for that question, so its answer paths get exercised. Never invent a patient. If no shelf patient has evidence for a question, list it as a gap with a short brief describing the fake patient the shelf needs (characteristics only, no identifiers).

QUESTIONS:
${questions}

SHELF PATIENTS:
${patients}

Return JSON { "coverage": [{ "questionId": "...", "patientIds": ["..."] }], "gaps": [{ "questionId": "...", "brief": "..." }] }. Every question appears exactly once, in coverage (non-empty patientIds) or in gaps.`,
    output: obj({
      coverage: { type: "array", items: obj({ questionId: str, patientIds: { type: "array", minItems: 1, items: str } }) },
      gaps: { type: "array", items: obj({ questionId: str, brief: str }) },
    }),
  };
}

/** Test patient creator, step 1: the agent writes a patient plan from the brief. */
export function patientPlan(brief: string, question: string): Call {
  return {
    prompt: `Plan an invented home-health test patient for a prompt workbench shelf. It must look like a real visit (referral packet + today's visit notes) and must exercise this question: "${question}".

GAP BRIEF:
${brief}

Describe: age band, diagnoses, living situation, what the referral packet says, what today's visit notes must show, and any deliberate conflict between referral and notes that tests the question. Invented only: no names beyond a first-name label, no dates, no MRN, no phone numbers, no addresses.

Return JSON { "plan": "<the plan>" }.`,
    output: obj({ plan: { type: "string", minLength: 80 } }),
  };
}

/** Test patient creator, step 2: generate the chart from brief + plan. */
export function patientChart(brief: string, plan: string, findings: readonly string[]): Call {
  return {
    prompt: `Generate the invented home-health test patient described by this plan, in the shelf's chart shape.

GAP BRIEF:
${brief}

PATIENT PLAN:
${plan}
${findings.length ? `\nPatient QA rejected the previous chart for:\n- ${findings.join("\n- ")}\nFix every point.` : ""}
Rules: a first-name label only; no surnames, dates, MRNs, phone numbers or addresses. id is the lowercase label.
Return JSON { "id", "label", "ageBand", "visitType": "soc", "referral", "notes" }.`,
    output: obj({ id: { type: "string", pattern: "^[a-z][a-z0-9-]{1,30}$" }, label: str, ageBand: str, visitType: { const: "soc" }, referral: { type: "string", minLength: 60 }, notes: { type: "string", minLength: 80 } }),
  };
}

/** Patient QA: the chart against brief and plan. Loops until pass; then the patient locks. */
export function patientQa(brief: string, plan: string, patient: Omit<Patient, "locked" | "source">): Call {
  return {
    prompt: `You are Patient QA for an invented test patient. Check the chart against the gap brief and the plan: does it look like a real home-health visit, does it contain the evidence the brief needs, does it follow the plan, and is it free of identifiers (surnames, dates, MRN, phone, address)?

GAP BRIEF:
${brief}

PLAN:
${plan}

CHART:
${JSON.stringify(patient, null, 2)}

Return JSON { "pass": true|false, "findings": ["..."] }. pass is true only when findings is empty.`,
    output: qaSchema,
  };
}
