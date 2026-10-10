// spec-diff — what changed between two compiled flows, split into prompt
// edits and structural edits.
//
// Both inputs are the canonical JSON `compile-spec.mjs` writes, so the
// comparison is over what the kernel will actually execute, not over YAML
// formatting: a reflowed comment or re-quoted string is not an edit.

/** Fields that hold prompt text an agent or LLM step is handed. */
const PROMPT_FIELDS = new Set(["instruction", "prompt"]);
/** Flow-level fields that are labels, not behaviour. */
const LABEL_FIELDS = new Set(["name", "description", "version"]);
/** The owner recorded for a flow-level (not per-step) change. */
export const FLOW = "flow";

/** Dependencies are a set to the kernel: reordering them is not an edit. */
const normalize = (key, value) => (key === "depends_on" && Array.isArray(value) ? [...value].sort() : value);
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @returns {{ prompt: {step: string, field: string}[],
 *             structure: {step: string, field: string, before?: unknown, after?: unknown}[] }}
 *   `prompt` lists every step whose prompt text changed. `structure` lists
 *   every other change: `field` is the changed key, or `added`/`removed` for
 *   a whole step; flow-level changes carry `step: "flow"`.
 */
export function diffSpecs(before, after) {
  const prompt = [];
  const structure = [];

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "steps" || LABEL_FIELDS.has(key)) continue;
    if (!same(before[key], after[key])) structure.push({ step: FLOW, field: key });
  }

  const beforeSteps = new Map((before.steps ?? []).map((s) => [s.id, s]));
  const afterSteps = new Map((after.steps ?? []).map((s) => [s.id, s]));
  for (const id of beforeSteps.keys()) if (!afterSteps.has(id)) structure.push({ step: id, field: "removed" });
  for (const [id, step] of afterSteps) {
    const old = beforeSteps.get(id);
    if (old === undefined) { structure.push({ step: id, field: "added", after: step.type }); continue; }
    for (const key of new Set([...Object.keys(old), ...Object.keys(step)])) {
      if (same(normalize(key, old[key]), normalize(key, step[key]))) continue;
      if (PROMPT_FIELDS.has(key)) prompt.push({ step: id, field: key });
      else structure.push({ step: id, field: key, before: old[key], after: step[key] });
    }
  }
  return { prompt, structure };
}

/** One line per structural change, for the PR body and refusals. */
export function describeChange(change) {
  if (change.field === "added") return `step ${change.step} added (${change.after})`;
  if (change.field === "removed") return `step ${change.step} removed`;
  if (change.step === FLOW) return `flow.${change.field} changed`;
  return `step ${change.step}: ${change.field} changed`;
}

/**
 * Does the compiled diff implement the proposal, and only the proposal?
 *
 * A change is owned by a proposed step when it is that step, or a step the
 * compiler derived from it (`<step>.<suffix>`, e.g. the `classify.gate` step a
 * named gate lowers to). A `depends_on` change elsewhere is owned when every
 * dependency it adds or drops is itself owned: that is the rewiring an
 * inserted or removed step forces on its dependents.
 *
 * @returns {string[]} problems; empty when the diff and the proposal agree.
 */
export function coverage(diff, proposal) {
  const named = new Set([
    ...(proposal.prompt_edits ?? []).map((e) => e.step),
    ...(proposal.structure_edits ?? []).map((e) => e.step),
  ]);
  const owner = (id) => (named.has(id) ? id : [...named].find((n) => n !== FLOW && id.startsWith(`${n}.`)) ?? null);
  const problems = [];
  for (const p of diff.prompt) {
    if (owner(p.step) === null) problems.push(`step ${p.step}: ${p.field} changed, but the proposal has no edit for that step`);
  }
  for (const s of diff.structure) {
    if (owner(s.step) !== null) continue;
    if (s.field === "depends_on") {
      const was = new Set(s.before ?? []);
      const now = new Set(s.after ?? []);
      const moved = [...was].filter((d) => !now.has(d)).concat([...now].filter((d) => !was.has(d)));
      if (moved.every((d) => owner(d) !== null)) continue;
    }
    problems.push(`${describeChange(s)}, but the proposal has no edit for that step`);
  }
  for (const e of proposal.prompt_edits ?? []) {
    if (!diff.prompt.some((p) => owner(p.step) === e.step)) problems.push(`proposed prompt edit to ${e.step} is not in the compiled flow`);
  }
  for (const e of proposal.structure_edits ?? []) {
    if (!diff.structure.some((s) => owner(s.step) === e.step)) problems.push(`proposed structure edit to ${e.step} is not in the compiled flow`);
  }
  if (!named.has(proposal.target_step)) problems.push(`target_step ${proposal.target_step} has no proposed edit`);
  return problems;
}
