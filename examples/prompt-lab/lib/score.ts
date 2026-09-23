// "What the score looks like": worked = the new answer matches persisted gold
// for that question × patient. Un-golded patients are shown, never counted.
import type { Output } from "./types.ts";

export type Result = "worked" | "did not" | "no gold yet";
export interface ScoreRow { patientId: string; gold: string | null; rerun: string; result: Result }
export interface Score { rows: ScoreRow[]; golded: number; worked: number; percent: number | null }

export function score(questionId: string, rerun: Record<string, Output>, gold: Record<string, Output>): Score {
  const rows = Object.keys(rerun).sort().map((patientId): ScoreRow => {
    const g = gold[`${questionId}|${patientId}`];
    const answer = rerun[patientId]!.answer;
    if (!g) return { patientId, gold: null, rerun: answer, result: "no gold yet" };
    return { patientId, gold: g.answer, rerun: answer, result: g.answer === answer ? "worked" : "did not" };
  });
  const golded = rows.filter((r) => r.result !== "no gold yet").length;
  const worked = rows.filter((r) => r.result === "worked").length;
  return { rows, golded, worked, percent: golded ? Math.round((worked / golded) * 100) : null };
}

export function scoreTable(s: Score): string {
  const lines = s.rows.map((r) => `  ${r.patientId}: gold ${r.gold ?? "not set"} · new run ${r.rerun} · ${r.result}`);
  const head = s.percent === null ? "no golded patients yet" : `${s.worked} of ${s.golded} golded patients worked (${s.percent}%)`;
  return `${head}\n${lines.join("\n")}`;
}
