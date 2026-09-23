// The Output QA edit grid: what the reviewer edits between two human gates.
// Pure functions over journaled values; the flow does the reading and writing.
import { CONFIDENCES, type Output, type Pile } from "./types.ts";

export interface Row {
  questionId: string; patientId: string; pile: Pile;
  /** Why the computer put this row first. Empty = not highlighted. */
  highlight: string[];
  ai: Output;
  /** The reviewer's value. Prefilled from persisted targets/gold, else the AI output. */
  target: Output;
  notes: string;
}

export const rowKey = (r: { questionId: string; patientId: string }): string => `${r.questionId}|${r.patientId}`;

const sameOutput = (a: Output, b: Output): boolean =>
  a.answer === b.answer && a.confidence === b.confidence && a.explanation === b.explanation;

/** Deterministic "likely off" signals. The reviewer's time goes to these rows first. */
export function highlights(ai: Output, pile: Pile, newPrompt: boolean): string[] {
  const why: string[] = [];
  if (ai.confidence !== "High") why.push(`${ai.confidence.toLowerCase()} confidence`);
  if (pile === "mismatch") why.push("shared prompt, this agency's menu or ancestry differs");
  if (newPrompt) why.push("first-pass prompt, never reviewed");
  return why;
}

export function sortRows(rows: Row[]): Row[] {
  return [...rows].sort((a, b) =>
    Number(b.highlight.length > 0) - Number(a.highlight.length > 0) || rowKey(a).localeCompare(rowKey(b)));
}

/** Run iteration uses every row that changed — never the current selection. */
export const changed = (rows: readonly Row[]): Row[] =>
  rows.filter((r) => !sameOutput(r.ai, r.target) || r.notes.trim() !== "");

/** Refuses a grid the reviewer broke, rather than persisting a half-valid target. */
export function gridError(rows: unknown, options: Record<string, readonly string[]>): string | null {
  if (!Array.isArray(rows)) return "grid must be a JSON array of rows";
  for (const r of rows as Row[]) {
    const where = `${r?.questionId}|${r?.patientId}`;
    const menu = options[r?.questionId];
    if (!menu) return `${where}: unknown question`;
    if (!r.target || !menu.includes(r.target.answer)) return `${where}: target answer is not on the agency menu (${menu.join(" / ")})`;
    if (!CONFIDENCES.includes(r.target.confidence)) return `${where}: confidence must be High, Medium or Low`;
    if (typeof r.target.explanation !== "string" || typeof r.notes !== "string") return `${where}: explanation and notes must be text`;
  }
  return null;
}
