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
const ACTION_TITLE =
  /^(?:add|build|change|close|create|document|fix|implement|persist|refuse|release|remove|rename|replace|sharpen|update|validate|wire)\b/i;
const NOTES_TITLE = /^(?:notes?|release notes|upstream issues)\s*(?:\(|:|$)/i;
const VERIFICATION_SIGNAL =
  /\b(?:acceptance|done when|expected|must|should|assert|test(?:ed)?|verify|coverage|refus(?:e|ed|al)?|fail(?:s|ed|ure)?|error|wrong|drift|indistinguishable|brittle|compile[sd]?|declares?|collapses?)\b/i;
const COMMAND_PROSE_WORDS = new Set([
  'a',
  'an',
  'and',
  'are',
  'is',
  'of',
  'or',
  'the',
  'to',
]);

export interface BacklogEntry {
  title: string;
  body: string;
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

/** Accept a complete emitted package, or name the first missing requirement. */
export function validateWorkPackage(input: unknown): WorkPackageValidation {
  if (!isRecord(input) || !isNonEmptyString(input['title'])) {
    return { accepted: false, reason: 'missing_title' };
  }
  if (!isNonEmptyStringArray(input['files_in_scope'])) {
    return { accepted: false, reason: 'missing_scope' };
  }
  if (!isNonEmptyStringArray(input['definition_of_done'])) {
    return { accepted: false, reason: 'missing_definition_of_done' };
  }
  return { accepted: true, work: input as unknown as ValidatedWorkPackage };
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
  const files = scopeReferences(blob);
  const gate = blob.match(/\bgate[ -]?(\d+)\b/i);
  const explicitChecks = (entry.body.match(/`[^`]+`/g) || [])
    .map((candidate) => candidate.slice(1, -1))
    .filter((candidate) => /\s/.test(candidate));
  const statedOutcomes = verificationStatements(entry.body);
  const definitionOfDone = NOTES_TITLE.test(entry.title)
    ? []
    : explicitChecks.length > 0
      ? explicitChecks
      : ACTION_TITLE.test(entry.title)
        ? [entry.title.replace(/[.:]\s*$/, '')]
        : statedOutcomes;
  return {
    title: entry.title,
    description: entry.body,
    files_in_scope: files,
    gate: gate ? Number(gate[1]) : null,
    definition_of_done: definitionOfDone,
  };
}

/** Backticked paths, symbols, and command references are explicit scope. */
function scopeReferences(blob: string): string[] {
  const references = [...blob.matchAll(/`([^`]+)`/g)]
    .map((match) => match[1])
    .filter((candidate): candidate is string => candidate !== undefined)
    .filter((candidate) => {
      if (/^\/|\/\//.test(candidate)) return false;
      return !/\s/.test(candidate) || isCommandReference(candidate);
    });
  return [...new Set(references)];
}

/** Multiword shell-shaped references are scope; ordinary prose is not. */
function isCommandReference(candidate: string): boolean {
  const tokens = candidate.trim().split(/\s+/);
  if (tokens.length < 2 || !/^[A-Za-z_][\w./:@+-]*$/.test(tokens[0] ?? '')) return false;
  if (!tokens.every((token) => /^[\w./:@+=$<>-]+$/.test(token))) return false;
  return !tokens.some((token) => COMMAND_PROSE_WORDS.has(token.toLowerCase()));
}

/** Sentences that state an observable check or failure are verification evidence. */
function verificationStatements(body: string): string[] {
  return body
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.replace(/[.!?]+$/, '').trim())
    .filter((sentence) => sentence.length > 0 && VERIFICATION_SIGNAL.test(sentence));
}
