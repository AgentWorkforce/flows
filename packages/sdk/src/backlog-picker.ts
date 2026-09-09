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
const CODE_REFERENCE = /`([^`]+)`/g;
// Outcomes include explicit changes and concrete defect statements. A list of
// identifiers or links alone carries neither, so it cannot qualify as work.
const ENGINEERING_OUTCOME =
  /\b(?:add|asserts?|breaks?|build|cannot|capture|catches?|change|close|collapses?|cross-compile|delete|document|drift|duplicates?|fails?|fix|implement|invoke|leaks?|make|missing|must|needs?|no (?:end-to-end )?coverage|persist|refuse|register|replace|reserve|restore|run|scope|should|spawn|untested|update|use|validate|verified?|wire|wrong)\b/i;

export interface BacklogEntry {
  title: string;
  body: string;
  /**
   * Where the selected bullet actually starts and ends in the source markdown.
   * A caller advancing past this entry must slice by position: searching for
   * the title text finds the FIRST occurrence, which may be a mention inside an
   * earlier entry's body rather than this bullet.
   */
  index: number;
  endIndex: number;
}

export interface ValidatedWorkPackage {
  title: string;
  files_in_scope: string[];
  definition_of_done: string[];
  description?: string;
  gate?: number | null;
}

export type WorkPackageValidationReason =
  | 'missing_title'
  | 'unterminated_backticks'
  | 'missing_scope'
  | 'missing_definition_of_done';

export type WorkPackageValidation =
  | { accepted: true; work: ValidatedWorkPackage }
  | { accepted: false; reason: WorkPackageValidationReason };

/**
 * Returns the selected entry, or null when the backlog holds no actionable
 * one. Null is a real answer — "nothing to do" — not a failure.
 */
export function selectBacklogEntry(markdown: string): BacklogEntry | null {
  const match = ENTRY.exec(markdown);
  if (!match) return null;
  return {
    title: match[1] ?? '',
    body: (match[2] ?? '').trim(),
    index: match.index,
    endIndex: match.index + match[0].length,
  };
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

/** Accept a complete emitted package, or name the first missing requirement. */
export function validateWorkPackage(input: unknown): WorkPackageValidation {
  if (!isRecord(input) || !isNonEmptyString(input['title'])) {
    return { accepted: false, reason: 'missing_title' };
  }
  if (hasUnterminatedBackticks(input)) {
    return { accepted: false, reason: 'unterminated_backticks' };
  }
  if (!isNonEmptyStringArray(input['files_in_scope'])) {
    return { accepted: false, reason: 'missing_scope' };
  }
  if (!isNonEmptyStringArray(input['definition_of_done'])) {
    return { accepted: false, reason: 'missing_definition_of_done' };
  }
  return { accepted: true, work: input as unknown as ValidatedWorkPackage };
}

/** Whether the backlog text used to derive a package has an unmatched backtick. */
export function hasUnterminatedBackticks(input: Record<string, unknown>): boolean {
  const text = [input['title'], input['description']]
    .filter((value): value is string => typeof value === 'string')
    .join(' ');
  return (text.match(/`/g)?.length ?? 0) % 2 === 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isNonEmptyStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0 && value.every(isNonEmptyString);
}

/**
 * Build a work package from a backlog entry.
 *
 * This lives in the SDK because two flow steps need it: `select-entry` has to
 * build a candidate package to know whether an entry is actionable at all, and
 * `emit-package` has to build the package it emits. When the logic was inlined
 * in both, the two could drift silently — the flow would select an entry on one
 * rule and describe it by another.
 */
export function packageFromEntry(entry: BacklogEntry): Record<string, unknown> {
  const blob = `${entry.title} ${entry.body}`;
  const references = [...entry.body.matchAll(CODE_REFERENCE)].map((match) => match[1] ?? '');
  const files = [
    ...new Set(
      references
        .filter(
          (candidate): candidate is string =>
            /^[A-Za-z_][A-Za-z0-9._-]*(?:\/[A-Za-z0-9._-]*)+$/.test(candidate) &&
            !/^\/|\/\//.test(candidate),
        ),
    ),
  ];
  const hasEngineeringOutcome = ENGINEERING_OUTCOME.test(entry.body);
  // A symbol or command locates work in this repository, but not necessarily
  // one file. Preserve that honest breadth instead of discarding the signal.
  if (files.length === 0 && references.length > 0 && hasEngineeringOutcome) {
    files.push('.');
  }
  const gate = blob.match(/\bgate[ -]?(\d+)\b/i);
  const definitionOfDone = hasEngineeringOutcome
    ? [entry.title.replace(/[.:]\s*$/, '')]
    : [];
  return {
    title: entry.title,
    description: entry.body,
    files_in_scope: files,
    gate: gate ? Number(gate[1]) : null,
    definition_of_done: definitionOfDone,
  };
}
