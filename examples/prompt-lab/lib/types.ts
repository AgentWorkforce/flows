// The Prompt Lab domain, as the brief names it. Plain data: every value here
// crosses a journaled step boundary as JSON.

export type Confidence = "High" | "Medium" | "Low";
export const CONFIDENCES: readonly Confidence[] = ["High", "Medium", "Low"];

/** What the chart-filling engine returns for one question on one visit. */
export interface Output { answer: string; confidence: Confidence; explanation: string }

export interface Question {
  text: string;
  type: "single";
  /** Apricot's live prompt. Null until a first-pass prompt is committed. */
  livePromptId: string | null;
  /** A proposed prompt that is not live. Done = live moves it to livePromptId. */
  draftPromptId?: string | null;
}

/** Apricot's Bank: prompts are global, keyed by id; questions point at one. */
export interface Bank { prompts: Record<string, string>; questions: Record<string, Question> }

/** One question as a given agency asks it: its answer menu and follow-up parent. */
export interface AgencyQuestion { questionId: string; options: string[]; parent?: string }
export interface Agency { name: string; visitTypes: Record<string, AgencyQuestion[]> }

/** A locked, invented shelf patient. Never a real chart or a scrubbed clone. */
export interface Patient {
  id: string; label: string; locked: true; source: "invented";
  ageBand: string; visitType: string; referral: string; notes: string;
}

/** A gap brief: coverage the shelf does not have yet. Lives on the manager queue. */
export interface PatientBrief {
  id: string; questionId: string; brief: string; from: "planner" | "you" | "issue";
  status: "queued" | "locked";
}

/** A config-send, field-pattern or Apricot issue on the question manager. */
export interface Issue {
  id: string; kind: "config-send" | "apricot" | "field-pattern";
  questionIds: string[]; text: string; status: "open" | "done";
  /** The agency whose menu the rows were answered on, when one sent it. */
  agency?: string;
  /** Config-level targets travel with a row sent to question-level. */
  targets?: Record<string, Output>;
  proposedPrompt?: string;
}

export type Pile = "agency-specific" | "shared" | "mismatch";

/** Everything a job reads at its start, in one journaled step. */
export interface Snapshot {
  bank: Bank; agencies: Record<string, Agency>; guidelines: string;
  shelf: Patient[]; briefs: Record<string, string>;
  targets: Record<string, Output>; gold: Record<string, Output>;
  issues: Issue[]; patientBriefs: PatientBrief[];
}
