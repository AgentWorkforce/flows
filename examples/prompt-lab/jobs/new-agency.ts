// Job 1 — new agency (brief: "Config-level / new agency").
//
//   System  lookup piles: agency-specific, shared, mismatch
//   System  first-pass prompt text for agency-specific questions with none → Prompt QA
//   System  test planner picks path-covering shelf patients; gaps → patient-manager queue
//   System  run on fake visits → edit grid, computer-highlighted rows first
//   You     edit each row on the first QA pass
//   Outcome targets persist for question × patient
//   System  run iteration on every changed question
//   System  shared rows → question-level queue with their targets (frozen here)
//   You     commit all / only / all except
//   Outcome committed agency-specific prompts are live in Apricot
import { toCommit, commitError, type CommitChoice } from "../lib/commit.ts";
import { changed, gridError, highlights, rowKey, sortRows, type Row } from "../lib/grid.ts";
import { hash8 } from "../lib/hash.ts";
import { piles, type PiledQuestion } from "../lib/piles.ts";
import type { Issue, Output, Patient, PatientBrief } from "../lib/types.ts";
import { firstPass, iterate, promptQa, type Ask } from "../prompts.ts";
import type { Job } from "./job.ts";
import { shellWord } from "../lib/lab.ts";
import { gapId, llm, MAX_ATTEMPTS, planCoverage, runEngine, untilQaPasses } from "./shared.ts";

export interface NewAgencyInput { agency: string; visitType: string }

export async function newAgency(job: Job, input: NewAgencyInput): Promise<void> {
  const { f, lab, reviewer } = job;
  const snap = await lab.snapshot();
  const piled = piles(snap.agencies, input.agency, input.visitType);
  const ask = (q: PiledQuestion): Ask => ({ question: snap.bank.questions[q.questionId]!.text, options: q.options });
  const byId = new Map(piled.map((q) => [q.questionId, q]));
  const patient = new Map(snap.shelf.map((p) => [p.id, p]));

  // Prompt text per question: Apricot's live prompt, or a first-pass v0 for an
  // agency-specific question that has none. Shared prompts are never written here.
  const prompts = new Map<string, { text: string; firstPass: boolean }>();
  const drafts = new Map<string, string>(); // questionId → draft promptId in the Bank
  for (const q of piled) {
    const live = snap.bank.questions[q.questionId]?.livePromptId;
    if (live) { prompts.set(q.questionId, { text: snap.bank.prompts[live]!, firstPass: false }); continue; }
    if (q.pile !== "agency-specific") throw new Error(`shared question ${q.questionId} has no live prompt; fix it at question-level first`);
    const brief = snap.briefs[q.questionId];
    const v0 = await untilQaPasses<{ prompt: string }>(f,
      (findings) => firstPass(ask(q), snap.guidelines, brief, findings),
      (w) => promptQa(w.prompt, ask(q), snap.guidelines, brief));
    if (!v0.passed) {
      await f.run(`echo ${shellWord(`first-pass prompt for ${q.questionId} failed Prompt QA ${MAX_ATTEMPTS} times: ${v0.findings.join("; ")}`)} >&2`);
      return f.done("needs_human");
    }
    drafts.set(q.questionId, (await lab.draft(q.questionId, v0.value.prompt)).promptId);
    prompts.set(q.questionId, { text: v0.value.prompt, firstPass: true });
  }

  // Test planner: existing shelf patients of this visit type only; holes become
  // briefs on the manager queue for that visit type.
  const shelf = snap.shelf.filter((p) => p.visitType === input.visitType);
  const plan = await planCoverage(f, piled.map((q) => ({ id: q.questionId, ...ask(q) })), shelf);
  for (const gap of plan.gaps) {
    const brief: PatientBrief = { id: gapId(gap.questionId, input.visitType), questionId: gap.questionId, visitType: input.visitType, brief: gap.brief, from: "planner", status: "queued" };
    await lab.enqueue("patient-briefs", brief);
  }

  // Run on fake visits — the background job; the grid fills when it finishes.
  const ran: { q: PiledQuestion; outputs: Record<string, Output> }[] = [];
  for (const c of plan.coverage) { // sequential: see runEngine
    const q = byId.get(c.questionId)!;
    const shelf = c.patientIds.map((id) => patient.get(id)!);
    ran.push({ q, outputs: await runEngine(f, prompts.get(q.questionId)!.text, ask(q), shelf) });
  }
  const rows = sortRows(ran.flatMap(({ q, outputs }) => Object.entries(outputs).map(([patientId, ai]): Row => ({
    questionId: q.questionId, patientId, pile: q.pile,
    highlight: highlights(ai, q.pile, prompts.get(q.questionId)!.firstPass),
    ai, target: snap.targets[`${input.agency}|${q.questionId}|${patientId}`] ?? ai, notes: "",
  }))));
  const work = `work/${input.agency}-${input.visitType}/${hash8(rows)}`;
  await lab.writeNew(`${work}/grid.json`, rows);

  const flagged = rows.filter((r) => r.highlight.length).length;
  const reviewed = await f.human(
    `Config workbench · ${input.agency} ${input.visitType}: ${rows.length} rows on ${plan.coverage.length} questions (${flagged} highlighted, listed first); ${plan.gaps.length} gap brief(s) queued for the test patient manager.\n` +
    `Edit target answer / confidence / explanation / notes in ${job.labDir}/${work}/grid.json. Your first pass persists as the target for each question × patient.\n` +
    `yes = persist targets and run iteration on every changed row; no = stop without persisting.`,
    { to: reviewer });
  if (!reviewed) return f.done("declined");

  const menus = Object.fromEntries(piled.map((q) => [q.questionId, q.options]));
  const expected = rows.map(rowKey).sort().join(",");
  const edited = await lab.read<Row[]>(`${work}/grid.json`, (g) =>
    gridError(g, menus) ?? (g.map(rowKey).sort().join(",") === expected ? null : "rows were added or removed; edit values only"));
  await lab.record("targets", Object.fromEntries(edited.map((r) => [`${input.agency}|${rowKey(r)}`, r.target])));

  // Run iteration on every question with a changed row. Agency-specific rewrites
  // are commit candidates (Prompt QA'd); shared/mismatch get a proposed rewrite only.
  const changes = changed(edited);
  const changedQs = [...new Set(changes.map((r) => r.questionId))].sort();
  const rewrites: { q: PiledQuestion; rows: Row[]; prompt: string; passed: boolean }[] = [];
  for (const qid of changedQs) { // sequential: see runEngine
    const q = byId.get(qid)!;
    const rowsFor = changes.filter((r) => r.questionId === qid)
      .map((r) => ({ patient: patient.get(r.patientId)! as Patient, ai: r.ai, target: r.target, notes: r.notes }));
    const brief = snap.briefs[qid];
    const existing = prompts.get(qid)!.text;
    const rows = changes.filter((r) => r.questionId === qid);
    if (q.pile !== "agency-specific") {
      const { prompt } = await llm<{ prompt: string }>(f, iterate(ask(q), existing, brief, rowsFor, []));
      rewrites.push({ q, rows, prompt, passed: true });
      continue;
    }
    const r = await untilQaPasses<{ prompt: string }>(f,
      (findings) => iterate(ask(q), existing, brief, rowsFor, findings),
      (w) => promptQa(w.prompt, ask(q), snap.guidelines, brief));
    rewrites.push({ q, rows, prompt: r.value.prompt, passed: r.passed });
  }

  // A first-pass prompt is a candidate only once it ran on a shelf patient and
  // you reviewed the rows; a gap-only draft waits for a patient that covers it.
  const covered = new Set(plan.coverage.map((c) => c.questionId));
  const candidates = new Set(piled.filter((q) => q.pile === "agency-specific" && prompts.get(q.questionId)!.firstPass && covered.has(q.questionId)).map((q) => q.questionId));
  const waiting = piled.filter((q) => prompts.get(q.questionId)!.firstPass && !covered.has(q.questionId)).map((q) => q.questionId);
  const sent: string[] = [];
  for (const r of rewrites) {
    if (r.q.pile === "agency-specific") {
      if (!r.passed) { candidates.delete(r.q.questionId); continue; } // an uncompliant rewrite never becomes a candidate
      drafts.set(r.q.questionId, (await lab.draft(r.q.questionId, r.prompt)).promptId);
      candidates.add(r.q.questionId);
      continue;
    }
    // Frozen here: the rows travel to question-level with their targets and the proposal.
    const issue: Issue = {
      id: `config-${input.agency}-${r.q.questionId}-${hash8(r.rows)}`, kind: "config-send", questionIds: [r.q.questionId], status: "open", agency: input.agency,
      text: `${input.agency} ${input.visitType} first pass changed ${r.rows.length} row(s) on a ${r.q.pile} question (shared with ${r.q.sharedWith.join(", ")}). ${r.rows.map((x) => x.notes).filter(Boolean).join(" ")}`.trim(),
      targets: Object.fromEntries(r.rows.map((x) => [x.patientId, x.target])), proposedPrompt: r.prompt,
    };
    await lab.enqueue("issues", issue);
    sent.push(`${r.q.questionId} → ${issue.id}`);
  }

  const list = [...candidates].sort();
  if (list.length === 0) return f.done("success"); // nothing agency-specific to commit; shared work continues at question-level
  await lab.writeNew(`${work}/commit.json`, { mode: "all", questions: [] } satisfies CommitChoice);
  const commit = await f.human(
    `Commit output · ${input.agency}: agency-specific prompts ready to go live in Apricot: ${list.join(", ")}.\n` +
    `Sent to the question manager (frozen here): ${sent.length ? sent.join("; ") : "none"}.\n` +
    (waiting.length ? `Held as drafts until a shelf patient covers them: ${waiting.join(", ")}.\n` : "") +
    `To commit only some, edit ${job.labDir}/${work}/commit.json: {"mode":"only"|"except","questions":[...]}.\n` +
    `yes = commit (Done = live, no promote step); no = leave them as drafts.`,
    { to: reviewer });
  if (!commit) return f.done("declined");
  const choice = await lab.read<CommitChoice>(`${work}/commit.json`, commitError);
  for (const qid of toCommit(list, choice)) await lab.publish(qid, drafts.get(qid)!);
  return f.done("success");
}
