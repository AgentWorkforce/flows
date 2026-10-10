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
 *   `prompt` lists every step whose prompt text changed, including a new
 *   step that carries one. `structure` lists
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
    if (old === undefined) {
      // A new agent/llm step is both a structural change and a new prompt.
      structure.push({ step: id, field: "added", after: step.type });
      for (const key of PROMPT_FIELDS) if (step[key] !== undefined) prompt.push({ step: id, field: key });
      continue;
    }
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

/** The prompt text a compiled step is handed, whichever field carries it. */
const promptOf = (step) => step?.instruction ?? step?.prompt;
/**
 * Exact, except for the one newline a YAML `|` block scalar appends: the
 * proposal cannot know which scalar style the editor will choose.
 */
const sameText = (a, b) => a.replace(/\n$/u, "") === b.replace(/\n$/u, "");

/**
 * Does the compiled diff implement the proposal, and only the proposal?
 *
 * Prompt edits are checked by value: the step's compiled `instruction` (or
 * `prompt`) must be exactly the proposed `new_text`. Structure edits are
 * checked by (step, field) — `field` is the compiled-spec key the edit
 * changes (`max_iterations`, `verification`, `depends_on`, `added`,
 * `removed`, or a flow-level key with step "flow"). Every proposed pair must
 * appear in the diff, and every structural change in the diff must be a
 * proposed pair, unless it is
 *   - a change to a step the compiler made from a step whose proposal
 *     changes `verification` or adds the step: a compiled step whose id the
 *     YAML does not declare (`authored`, from compile-spec.mjs), bound to
 *     that step's output (`input.output.step`) — the gate a named gate
 *     lowers to (packages/sdk/src/named-gate-lowering.ts). Only absence from
 *     the YAML proves the compiler made it: an authored step can copy any
 *     name or shape, and is never exempt.
 *   - a `depends_on` change elsewhere that only rewires around an inserted or
 *     removed step. Each added or dropped dependency must be a step the
 *     proposal adds or removes, a derived gate step, or the parent a derived
 *     gate step replaces in the same list.
 * Values of structural fields are not compared: the YAML an agent writes and
 * the canonical form it compiles to differ (a named gate lowers to a step),
 * so the field is the finest grain that is checkable without guessing.
 *
 * @returns {string[]} problems; empty when the diff and the proposal agree.
 */
/** Steps in `spec` the compiler generated from `producer`'s gate: not authored, bound to its output. */
function generatedFrom(spec, producer, authored) {
  return (spec.steps ?? [])
    .filter((s) => !authored.has(s.id) && s.input?.output?.step === producer)
    .map((s) => s.id);
}

/**
 * @param {{before: Set<string>, after: Set<string>}} authored the step ids each
 *   YAML declares, as compile-spec.mjs writes them.
 */
export function coverage(diff, proposal, after, before, authored) {
  const prompts = proposal.prompt_edits ?? [];
  const structural = proposal.structure_edits ?? [];
  const named = new Set([...prompts.map((e) => e.step), ...structural.map((e) => e.step)]);
  const proposed = (step, field) => structural.some((e) => e.step === step && e.field === field);
  const derived = new Set(structural
    .filter((e) => e.field === "verification" || e.field === "added")
    .flatMap((e) => [...generatedFrom(before, e.step, authored.before), ...generatedFrom(after, e.step, authored.after)]));
  const parentOf = (id) => structural.find((e) =>
    [...generatedFrom(before, e.step, authored.before), ...generatedFrom(after, e.step, authored.after)].includes(id))?.step;
  const insertedOrRemoved = new Set([
    ...structural.filter((e) => e.field === "added" || e.field === "removed").map((e) => e.step),
    ...derived,
  ]);
  const afterSteps = new Map((after.steps ?? []).map((s) => [s.id, s]));
  const rewiring = (s) => {
    const was = new Set(s.before ?? []);
    const now = new Set(s.after ?? []);
    const added = [...now].filter((d) => !was.has(d));
    const dropped = [...was].filter((d) => !now.has(d));
    return added.every((d) => insertedOrRemoved.has(d) || dropped.some((x) => derived.has(x) && parentOf(x) === d))
      && dropped.every((d) => insertedOrRemoved.has(d) || added.some((x) => derived.has(x) && parentOf(x) === d));
  };
  const problems = [];

  for (const p of diff.prompt) {
    if (!prompts.some((e) => e.step === p.step)) problems.push(`step ${p.step}: ${p.field} changed, but the proposal has no prompt edit for it`);
  }
  for (const e of prompts) {
    const text = promptOf(afterSteps.get(e.step));
    if (text === undefined) problems.push(`proposed prompt edit to ${e.step}: the compiled flow has no such step with a prompt`);
    else if (!sameText(text, String(e.new_text))) problems.push(`proposed prompt edit to ${e.step}: its compiled prompt is not the proposed new_text`);
    else if (!diff.prompt.some((p) => p.step === e.step)) problems.push(`proposed prompt edit to ${e.step} does not change it`);
  }
  for (const s of diff.structure) {
    if (proposed(s.step, s.field) || derived.has(s.step)) continue;
    if (s.field === "depends_on" && rewiring(s)) continue;
    problems.push(`${describeChange(s)}, but no structure edit proposes ${s.step}.${s.field}`);
  }
  for (const e of structural) {
    if (!diff.structure.some((s) => s.step === e.step && s.field === e.field)) {
      problems.push(`proposed structure edit ${e.step}.${e.field} is not in the compiled flow`);
    }
  }
  if (!named.has(proposal.target_step)) problems.push(`target_step ${proposal.target_step} has no proposed edit`);
  return problems;
}
