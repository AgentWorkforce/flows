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

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * @returns {{ prompt: {step: string, field: string}[], structure: string[] }}
 *   `prompt` lists every step whose prompt text changed; `structure` is one
 *   human-readable line per structural change.
 */
export function diffSpecs(before, after) {
  const prompt = [];
  const structure = [];

  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key === "steps" || LABEL_FIELDS.has(key)) continue;
    if (!same(before[key], after[key])) structure.push(`flow.${key} changed`);
  }

  const beforeSteps = new Map((before.steps ?? []).map((s) => [s.id, s]));
  const afterSteps = new Map((after.steps ?? []).map((s) => [s.id, s]));
  for (const id of beforeSteps.keys()) if (!afterSteps.has(id)) structure.push(`step ${id} removed`);
  for (const [id, step] of afterSteps) {
    const old = beforeSteps.get(id);
    if (old === undefined) { structure.push(`step ${id} added (${step.type})`); continue; }
    for (const key of new Set([...Object.keys(old), ...Object.keys(step)])) {
      if (same(old[key], step[key])) continue;
      if (PROMPT_FIELDS.has(key)) prompt.push({ step: id, field: key });
      else structure.push(`step ${id}: ${key} changed`);
    }
  }
  return { prompt, structure };
}
