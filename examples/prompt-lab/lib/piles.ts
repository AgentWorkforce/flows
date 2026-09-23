// The three sharing piles. A deterministic Bank/config lookup, never an agent,
// with no override (brief: "Sharing piles").
import type { Agency, AgencyQuestion, Pile } from "./types.ts";

export interface PiledQuestion extends AgencyQuestion { pile: Pile; sharedWith: string[] }

const sameList = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((v, i) => v === b[i]);

/** Every other agency's asking of `questionId`, across all its visit types. */
function othersAsking(agencies: Record<string, Agency>, self: string, questionId: string) {
  const found: { agency: string; q: AgencyQuestion }[] = [];
  for (const [id, agency] of Object.entries(agencies)) {
    if (id === self) continue;
    for (const qs of Object.values(agency.visitTypes)) {
      for (const q of qs) if (q.questionId === questionId) found.push({ agency: id, q });
    }
  }
  return found;
}

export function piles(agencies: Record<string, Agency>, agencyId: string, visitType: string): PiledQuestion[] {
  const questions = agencies[agencyId]?.visitTypes[visitType];
  if (!questions) throw new Error(`agency ${agencyId} has no visit type ${visitType}`);
  return questions.map((q) => {
    const others = othersAsking(agencies, agencyId, q.questionId);
    const sharedWith = [...new Set(others.map((o) => o.agency))].sort();
    if (others.length === 0) return { ...q, pile: "agency-specific", sharedWith };
    const identical = others.every((o) => sameList(o.q.options, q.options) && o.q.parent === q.parent);
    return { ...q, pile: identical ? "shared" : "mismatch", sharedWith };
  });
}

/** Every agency whose config asks `questionId` — the blast radius of a question-level done. */
export function agenciesUsing(agencies: Record<string, Agency>, questionId: string): string[] {
  return Object.entries(agencies)
    .filter(([, a]) => Object.values(a.visitTypes).some((qs) => qs.some((q) => q.questionId === questionId)))
    .map(([id]) => id).sort();
}

/** The distinct answer menus `questionId` is asked with, each with the agencies that use it. */
export function distinctMenus(agencies: Record<string, Agency>, using: readonly string[], questionId: string): { options: string[]; agencies: string[] }[] {
  const menus: { options: string[]; agencies: string[] }[] = [];
  for (const id of using) {
    for (const qs of Object.values(agencies[id]!.visitTypes)) {
      for (const q of qs) {
        if (q.questionId !== questionId) continue;
        const same = menus.find((m) => sameList(m.options, q.options));
        if (!same) menus.push({ options: q.options, agencies: [id] });
        else if (!same.agencies.includes(id)) same.agencies.push(id);
      }
    }
  }
  return menus;
}
