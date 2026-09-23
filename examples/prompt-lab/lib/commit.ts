// Config-level Commit output: all / only (selected) / all except (excluded),
// over agency-specific iterated prompts only. Shared never commits here.

export interface CommitChoice { mode: "all" | "only" | "except"; questions: string[] }

export function commitError(choice: unknown): string | null {
  const c = choice as CommitChoice;
  if (!c || !["all", "only", "except"].includes(c.mode)) return 'commit.json: mode must be "all", "only" or "except"';
  if (!Array.isArray(c.questions) || !c.questions.every((q) => typeof q === "string")) return "commit.json: questions must be a list of question ids";
  return null;
}

export function toCommit(candidates: readonly string[], choice: CommitChoice): string[] {
  if (choice.mode === "all") return [...candidates];
  if (choice.mode === "only") return candidates.filter((q) => choice.questions.includes(q));
  return candidates.filter((q) => !choice.questions.includes(q));
}
