// Job 2 — detect and fix one question (brief: "Question-level refinement").
//
//   You     select a question (you opened it, or an issue)
//   System  shelf patients (test planner) + the issue's patients; gaps → queue
//   System  generate answers on the selected patients with the live prompt
//   You     edit answer / confidence / explanation → gold
//   Outcome first pass persists as gold; config targets arrive prefilled
//   System  iterator rewrites prompt text → Prompt QA → re-run → % worked + per patient
//   You     review the new output → mark done
//   Outcome live in Apricot immediately (a shared question: every agency)
import { changed, gridError, highlights, rowKey, type Row } from "../lib/grid.ts";
import { hash8 } from "../lib/hash.ts";
import { shellWord } from "../lib/lab.ts";
import { agenciesUsing, distinctMenus } from "../lib/piles.ts";
import { score, scoreTable, type Score } from "../lib/score.ts";
import type { Output, PatientBrief } from "../lib/types.ts";
import { iterate, promptQa, type Ask } from "../prompts.ts";
import type { Job } from "./job.ts";
import { gapId, MAX_ATTEMPTS, planCoverage, runEngine, untilQaPasses } from "./shared.ts";

export interface FixInput { questionId?: string; issueId?: string; agency?: string }

export async function fix(job: Job, input: FixInput): Promise<void> {
  const { f, lab, reviewer } = job;
  const snap = await lab.snapshot();
  const issue = input.issueId ? snap.issues.find((i) => i.id === input.issueId && i.status === "open") : undefined;
  if (input.issueId && !issue) throw new Error(`no open issue ${input.issueId} on the question manager`);
  const qid = input.questionId ?? (issue?.questionIds.length === 1 ? issue.questionIds[0] : undefined);
  if (!qid || (issue && !issue.questionIds.includes(qid))) throw new Error("name questionId: one of the issue's tagged questions");
  const question = snap.bank.questions[qid];
  if (!question?.livePromptId) throw new Error(`question ${qid} has no live prompt; stand it up with Job 1 first`);
  const live = snap.bank.prompts[question.livePromptId]!;

  const using = agenciesUsing(snap.agencies, qid);
  const agency = input.agency ?? issue?.agency ?? using[0]!;
  const asked = Object.entries(snap.agencies[agency]?.visitTypes ?? {})
    .flatMap(([visitType, qs]) => qs.filter((q) => q.questionId === qid).map((q) => ({ visitType, options: q.options })))[0];
  if (!asked) throw new Error(`agency ${agency} does not ask ${qid}`);
  const menu = asked.options;
  const ask: Ask = { question: question.text, options: menu };
  // A prompt is global: done changes it on every agency's menu, so the re-run
  // checks every distinct menu, not only the one gold was set on.
  const menus = distinctMenus(snap.agencies, using, qid);
  const pile = using.length > 1 ? "shared" : "agency-specific";
  const brief = snap.briefs[qid];

  // Recreate: shelf patients that can show the issue, plus any the issue's targets name.
  const plan = await planCoverage(f, [{ id: qid, ...ask }], snap.shelf);
  const ids = new Set([...(plan.coverage[0]?.patientIds ?? []), ...Object.keys(issue?.targets ?? {})]);
  if (plan.gaps[0]) {
    const gap: PatientBrief = { id: gapId(qid, asked.visitType), questionId: qid, visitType: asked.visitType, brief: plan.gaps[0].brief, from: "planner", status: "queued" };
    await lab.enqueue("patient-briefs", gap);
  }
  const patients = snap.shelf.filter((p) => ids.has(p.id));
  if (patients.length === 0) return f.done("needs_human"); // nothing on the shelf can show it yet; the gap brief is queued

  const current = await runEngine(f, live, ask, patients);
  const rows: Row[] = patients.map((p) => {
    const ai = current[p.id]!;
    const target = snap.gold[`${qid}|${p.id}`] ?? issue?.targets?.[p.id] ?? ai;
    const why = highlights(ai, pile, false);
    if (target.answer !== ai.answer) why.push(snap.gold[`${qid}|${p.id}`] ? "disagrees with gold" : "disagrees with the config-level target");
    return { questionId: qid, patientId: p.id, pile, highlight: why, ai, target, notes: "" };
  });
  const work = `work/q-${qid}/${hash8(rows)}`;
  await lab.writeNew(`${work}/grid.json`, rows);

  const golded = await f.human(
    `Question workbench · ${qid}${issue ? ` (issue ${issue.id})` : ""}: current-prompt outputs on ${rows.length} shelf patient(s) — ${rows.map((r) => `${r.patientId}: ${r.ai.answer}/${r.ai.confidence}`).join(", ")}.\n` +
    `Set gold in ${job.labDir}/${work}/grid.json ("target" per row; prefilled from persisted gold or the config-level target). Your review persists as gold; later AI runs never overwrite it.\n` +
    `yes = persist gold and run the iterator; no = stop.`,
    { to: reviewer });
  if (!golded) return f.done("declined");

  const expected = rows.map(rowKey).sort().join(",");
  const edited = await lab.read<Row[]>(`${work}/grid.json`, (g) =>
    gridError(g, { [qid]: menu }) ?? (g.map(rowKey).sort().join(",") === expected ? null : "rows were added or removed; edit values only"));
  const gold: Record<string, Output> = Object.fromEntries(edited.map((r) => [rowKey(r), r.target]));
  await lab.record("gold", gold);

  const changes = changed(edited);
  if (changes.length === 0) {
    // The live prompt already matches gold: the issue is resolved, nothing to iterate.
    if (issue) await lab.closeIssue(issue.id);
    return f.done("success");
  }
  const byId = new Map(patients.map((p) => [p.id, p]));
  const changeset = changes.map((r) => ({ patient: byId.get(r.patientId)!, ai: r.ai, target: r.target, notes: r.notes }));
  const rewrite = await untilQaPasses<{ prompt: string }>(f,
    (findings) => iterate(ask, live, brief, changeset, findings),
    (w) => promptQa(w.prompt, ask, snap.guidelines, brief));
  if (!rewrite.passed) {
    await f.run(`echo ${shellWord(`iterated prompt for ${qid} failed Prompt QA ${MAX_ATTEMPTS} times: ${rewrite.findings.join("; ")}`)} >&2`);
    return f.done("needs_human");
  }
  const { promptId } = await lab.draft(qid, rewrite.value.prompt);

  // Re-run and score: required before done. Worked = new answer matches persisted gold.
  const allGold = { ...snap.gold, ...gold };
  const results: { agencies: string[]; options: string[]; score: Score; outputs: Record<string, Output> }[] = [];
  for (const m of menus) { // sequential: see runEngine
    const outputs = await runEngine(f, rewrite.value.prompt, { question: question.text, options: m.options }, patients);
    results.push({ ...m, score: score(qid, outputs, allGold), outputs });
  }
  await lab.writeNew(`${work}/score.json`, { promptId, menus: results });
  const table = results.map((r) => (results.length > 1 ? `Menu of ${r.agencies.join(", ")} (${r.options.join(" / ")}):\n` : "") + scoreTable(r.score)).join("\n");

  const shared = using.length > 1 ? `\nSHARED: marking done changes this prompt for every agency that uses it: ${using.join(", ")}.` : "";
  const done = await f.human(
    `Re-run and score · ${qid}, new prompt ${promptId}:\n${table}${shared}\n` +
    `Read the new prompt in ${job.labDir}/bank.json and the outputs in ${job.labDir}/${work}/score.json.\n` +
    `yes = mark done (live in Apricot now, no promote step); no = keep it as a draft and iterate again in a new run.`,
    { to: reviewer });
  if (!done) return f.done("declined");
  await lab.publish(qid, promptId, question.livePromptId);
  if (issue) await lab.closeIssue(issue.id);
  return f.done("success");
}
