/**
 * Gate-3 foundation: choose the next work package from ops/BACKLOG.md.
 *
 * The selection rule lived only inside a shell one-liner in
 * testdata/backlog-picker.flow.yaml, which made the flow's central claim —
 * that selection is DETERMINISTIC — impossible to assert. Review caught the
 * missing test (PR #20, P1). A rule that cannot be tested is a rule nobody can
 * rely on, so it lives here and the flow calls it.
 *
 * The rule: the first top-level bullet whose title is bold. Deliberately dull.
 * A Garden that proposes its own work must be predictable before it is clever
 * — if two runs over identical input can disagree, nothing downstream can
 * reason about what the system decided or why.
 */

/** First bold top-level bullet: `- **Title** rest`. */
const ENTRY = /^- \*\*(.+?)\*\*\s*(.*(?:\n  .*)*)/m;

export interface BacklogEntry {
  title: string;
  body: string;
}

/**
 * Returns the selected entry, or null when the backlog holds no actionable
 * one. Null is a real answer — "nothing to do" — not a failure.
 */
export function selectBacklogEntry(markdown: string): BacklogEntry | null {
  const match = ENTRY.exec(markdown);
  if (!match) return null;
  return { title: match[1] ?? '', body: (match[2] ?? '').trim() };
}

/** Render the selected entry as a work package. */
export function renderWorkPackage(entry: BacklogEntry): string {
  return [
    `# NEXT — ${entry.title}`,
    '',
    'Selected from ops/BACKLOG.md by the backlog picker (gate 3).',
    'Selection rule: the first top-level bullet whose title is bold.',
    '',
    '## Scope',
    '',
    entry.body || '(the backlog entry carried no detail beyond its title)',
    '',
    '## Definition of done',
    '',
    'Restate the entry as passing commands before building against it. An entry',
    'that cannot be turned into a command is not yet a work package.',
    '',
  ].join('\n');
}
