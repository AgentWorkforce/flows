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

/** Bold bullet candidate: `- **Title** rest`, with indentation retained. */
const ENTRY_LINE = /^(\s*)- \*\*(.+?)\*\*\s*(.*)$/;

export interface BacklogEntry {
  title: string;
  body: string;
}

export type BacklogPickerRefusalReason =
  | 'missing_body'
  | 'unterminated_backtick'
  | 'nested_bullet';

export type BacklogPickerResult =
  | { ok: true; entry: BacklogEntry }
  | { ok: false; reason: BacklogPickerRefusalReason }
  | null;

/** Select and validate the first bold bullet candidate. */
export function pickBacklogEntry(markdown: string): BacklogPickerResult {
  const lines = markdown.split(/\r?\n/);

  for (let index = 0; index < lines.length; index += 1) {
    const match = ENTRY_LINE.exec(lines[index] ?? '');
    if (!match) continue;
    if (match[1]) return { ok: false, reason: 'nested_bullet' };

    const bodyLines = [match[3] ?? ''];
    while (/^  \S/.test(lines[index + 1] ?? '')) {
      index += 1;
      bodyLines.push((lines[index] ?? '').slice(2));
    }

    const entry = { title: match[2] ?? '', body: bodyLines.join('\n').trim() };
    if (!entry.body) return { ok: false, reason: 'missing_body' };
    if ((`${entry.title} ${entry.body}`.match(/`/g)?.length ?? 0) % 2 !== 0) {
      return { ok: false, reason: 'unterminated_backtick' };
    }
    return { ok: true, entry };
  }

  return null;
}

/**
 * Returns the selected entry, or null when the backlog holds no actionable
 * one. Null is a real answer — "nothing to do" — not a failure.
 */
export function selectBacklogEntry(markdown: string): BacklogEntry | null {
  const result = pickBacklogEntry(markdown);
  return result?.ok ? result.entry : null;
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
