import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { commitError, toCommit } from "../lib/commit.ts";
import { changed, gridError, highlights, sortRows, type Row } from "../lib/grid.ts";
import { identifiers } from "../lib/phi.ts";
import { agenciesUsing, piles } from "../lib/piles.ts";
import { score } from "../lib/score.ts";
import type { Agency, Output, Patient } from "../lib/types.ts";
import { planError } from "../jobs/shared.ts";

const agencies = JSON.parse(readFileSync(new URL("../fixtures/agencies.json", import.meta.url), "utf8")) as Record<string, Agency>;
const out = (answer: string, confidence: Output["confidence"] = "High", explanation = "x"): Output => ({ answer, confidence, explanation });

test("piles: the brief's three examples, deterministic from config", () => {
  const byQ = Object.fromEntries(piles(agencies, "sunrise", "soc").map((q) => [q.questionId, q]));
  assert.equal(byQ["wound-status"]!.pile, "shared");
  assert.deepEqual(byQ["wound-status"]!.sharedWith, ["harbor", "maple"]);
  assert.equal(byQ["mood"]!.pile, "mismatch"); // same prompt, sunrise's menu adds "Agitated"
  assert.equal(byQ["living-situation"]!.pile, "agency-specific");
  assert.equal(byQ["ostomy-supplies"]!.pile, "agency-specific");
});

test("piles: a differing follow-up parent is a mismatch even with the same menu", () => {
  const a: Record<string, Agency> = {
    x: { name: "x", visitTypes: { soc: [{ questionId: "q", options: ["A", "B"], parent: "p1" }] } },
    y: { name: "y", visitTypes: { soc: [{ questionId: "q", options: ["A", "B"] }] } },
  };
  assert.equal(piles(a, "x", "soc")[0]!.pile, "mismatch");
  assert.throws(() => piles(a, "x", "roc"), /no visit type roc/);
});

test("agenciesUsing: the blast radius of a question-level done", () => {
  assert.deepEqual(agenciesUsing(agencies, "wound-status"), ["harbor", "maple", "sunrise"]);
  assert.deepEqual(agenciesUsing(agencies, "living-situation"), ["sunrise"]);
});

const row = (q: string, p: string, ai: Output, target: Output, extra: Partial<Row> = {}): Row =>
  ({ questionId: q, patientId: p, pile: "shared", highlight: [], ai, target, notes: "", ...extra });

test("grid: highlighted rows first; changed = any field or notes, never a selection", () => {
  assert.deepEqual(highlights(out("A", "High"), "shared", false), []);
  assert.deepEqual(highlights(out("A", "Low"), "mismatch", true), ["low confidence", "shared prompt, this agency's menu or ancestry differs", "first-pass prompt, never reviewed"]);
  const plain = row("a", "p", out("A"), out("A"));
  const flagged = row("b", "p", out("A"), out("A"), { highlight: ["low confidence"] });
  assert.deepEqual(sortRows([plain, flagged]).map((r) => r.questionId), ["b", "a"]);
  const explanationOnly = row("c", "p", out("A", "High", "x"), out("A", "High", "tightened"));
  const notesOnly = row("d", "p", out("A"), out("A"), { notes: "spouse is in the home" });
  assert.deepEqual(changed([plain, explanationOnly, notesOnly]).map((r) => r.questionId), ["c", "d"]);
});

test("grid: a reviewer edit off the agency menu is refused, naming the row", () => {
  const menus = { a: ["A", "B"] };
  assert.equal(gridError([row("a", "p", out("A"), out("B"))], menus), null);
  assert.match(gridError([row("a", "p", out("A"), out("C"))], menus)!, /a\|p: target answer is not on the agency menu/);
  assert.match(gridError([row("a", "p", out("A"), out("A", "Sure" as never))], menus)!, /confidence/);
  assert.match(gridError({}, menus)!, /array/);
});

test("score: the brief's example — 1 of 2 golded worked (50%), Riley shown but not counted", () => {
  const s = score("q", { pat: out("Ongoing"), jordan: out("Lives alone"), riley: out("Anxious") },
    { "q|pat": out("Ongoing"), "q|jordan": out("Lives with spouse") });
  assert.deepEqual(s.rows.map((r) => [r.patientId, r.result]), [["jordan", "did not"], ["pat", "worked"], ["riley", "no gold yet"]]);
  assert.equal(s.golded, 2); assert.equal(s.worked, 1); assert.equal(s.percent, 50);
  assert.equal(score("q", { riley: out("A") }, {}).percent, null);
});

test("commit: all / only / all except, over agency-specific candidates only", () => {
  const c = ["living-situation", "ostomy-supplies"];
  assert.deepEqual(toCommit(c, { mode: "all", questions: [] }), c);
  assert.deepEqual(toCommit(c, { mode: "only", questions: ["ostomy-supplies", "wound-status"] }), ["ostomy-supplies"]);
  assert.deepEqual(toCommit(c, { mode: "except", questions: ["ostomy-supplies"] }), ["living-situation"]);
  assert.match(commitError({ mode: "some" })!, /mode/);
  assert.match(commitError({ mode: "only", questions: "x" })!, /questions/);
});

test("phi floor: dates, phones, record numbers, addresses", () => {
  assert.deepEqual(identifiers("Pat, 75-84, lives alone, heel wound 2.0 x 1.5 cm"), []);
  assert.equal(identifiers("seen 3/14/2026").length, 1);
  assert.equal(identifiers("call 555-201-3344").length, 1);
  assert.equal(identifiers("MRN 12345678").length, 1);
  assert.equal(identifiers("lives at 12 Oak Street").length, 1);
});

test("test planner check: each question exactly once, shelf patients only", () => {
  const shelf = [{ id: "pat" }, { id: "jordan" }] as Patient[];
  const ok = { coverage: [{ questionId: "a", patientIds: ["pat"] }], gaps: [{ questionId: "b", brief: "..." }] };
  assert.equal(planError(ok, ["a", "b"], shelf), null);
  assert.match(planError({ ...ok, gaps: [] }, ["a", "b"], shelf)!, /b must appear exactly once/);
  assert.match(planError({ coverage: [{ questionId: "a", patientIds: ["ghost"] }], gaps: [{ questionId: "b", brief: "" }] }, ["a", "b"], shelf)!, /ghost is not on the shelf/);
  assert.match(planError({ ...ok, gaps: [...ok.gaps, { questionId: "z", brief: "" }] }, ["a", "b"], shelf)!, /not asked/);
});

import { parseReply, schemaError } from "../lib/reply.ts";
import { engine, planTests } from "../prompts.ts";

test("reply: one surrounding fence is tolerated; prose is not", () => {
  assert.deepEqual(parseReply('```json\n{"x":1}\n```'), { x: 1 });
  assert.deepEqual(parseReply('  {"x":1}  '), { x: 1 });
  assert.throws(() => parseReply('Here you go: {"x":1}'));
});

test("reply schema: the engine's answer enum is the agency menu", () => {
  const pat = { id: "pat", label: "Pat", locked: true, source: "invented", ageBand: "", visitType: "soc", referral: "", notes: "" } as const;
  const { output } = engine("p", { question: "q", options: ["Healed", "Ongoing"] }, pat);
  assert.equal(schemaError(output, { answer: "Ongoing", confidence: "Low", explanation: "e" }), null);
  assert.match(schemaError(output, { answer: "Closed", confidence: "Low", explanation: "e" })!, /\$\.answer must be one of "Healed", "Ongoing"/);
  assert.match(schemaError(output, { answer: "Healed", confidence: "Low" })!, /explanation is required/);
  assert.match(schemaError(output, { answer: "Healed", confidence: "Low", explanation: "e", extra: 1 })!, /extra is not allowed/);
  const plan = planTests([], []).output;
  assert.match(schemaError(plan, { coverage: [{ questionId: "a", patientIds: [] }], gaps: [] })!, /needs at least 1/);
  assert.throws(() => schemaError({ type: "string", format: "date" }, "x"), /not supported/);
});
