/** Normalized issue sources accepted by CLI and Cloud-authored flows. */
export type IssueSource = 'github' | 'linear' | 'shortcut' | 'jira' | 'slack' | 'markdown';

/** Input supplied by a source adapter, or directly when running a flow locally. */
export interface Issue {
  source: IssueSource;
  title: string;
  body: string;
  labels: string[];
  mentioned?: boolean;
  repository?: string;
  team?: string;
  workspace?: string;
  project?: string;
  channel?: string;
  path?: string;
}

/** Omitted sources are disabled; an empty source filter accepts every valid issue. */
export interface SourceFilters {
  github?: { repository?: string; labels?: readonly string[] };
  linear?: { team?: string; project?: string; labels?: readonly string[] };
  shortcut?: { workspace?: string; project?: string; labels?: readonly string[] };
  jira?: { project?: string; labels?: readonly string[] };
  slack?: { channel?: string; contains?: string; mentioned?: true };
  markdown?: { path?: string };
}

const filterKeys: Record<IssueSource, readonly string[]> = {
  github: ['repository', 'labels'],
  linear: ['team', 'project', 'labels'],
  shortcut: ['workspace', 'project', 'labels'],
  jira: ['project', 'labels'],
  slack: ['channel', 'contains', 'mentioned'],
  markdown: ['path'],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isStringArray(value: unknown): value is string[] {
  if (!Array.isArray(value)) return false;
  for (const item of value) if (typeof item !== 'string') return false;
  return true;
}

function isIssue(value: unknown): value is Issue {
  if (!isRecord(value) || typeof value.source !== 'string' ||
      !Object.hasOwn(filterKeys, value.source) || typeof value.title !== 'string' ||
      typeof value.body !== 'string' || !isStringArray(value.labels)) return false;
  if (value.mentioned !== undefined && typeof value.mentioned !== 'boolean') return false;
  return ['repository', 'team', 'workspace', 'project', 'channel', 'path'].every(key =>
    value[key] === undefined || typeof value[key] === 'string');
}

function validFilters(value: unknown): value is SourceFilters {
  if (!isRecord(value)) return false;
  return Reflect.ownKeys(value).every(source => {
    if (typeof source !== 'string' || !Object.hasOwn(filterKeys, source)) return false;
    const settings = value[source];
    if (!isRecord(settings)) return false;
    return Reflect.ownKeys(settings).every(key => {
      if (typeof key !== 'string' || !filterKeys[source as IssueSource].includes(key)) return false;
      const expected = settings[key];
      if (key === 'labels') return isStringArray(expected);
      if (key === 'mentioned') return expected === true;
      return typeof expected === 'string';
    });
  });
}

const normalize = (value: string): string => value.trim().toLowerCase();

/**
 * Validate a normalized issue and require every configured filter for its source.
 * Labels, identifiers and text ignore case and surrounding whitespace; channels
 * also allow a leading #. Markdown paths match exactly. `mentioned: true`
 * requires an explicit mention flag. Invalid input or filter configuration fails
 * closed. This pure helper does not fetch events, authenticate or subscribe.
 */
export function matchesIssue(issue: unknown, filters: SourceFilters): issue is Issue {
  if (!isIssue(issue) || !validFilters(filters) || !Object.hasOwn(filters, issue.source)) return false;
  const settings = filters[issue.source]!;
  return Object.getOwnPropertyNames(settings).every(key => {
    const expected = (settings as Record<string, unknown>)[key];
    if (key === 'labels') {
      const actual = issue.labels.map(normalize);
      return (expected as readonly string[]).every(label => actual.includes(normalize(label)));
    }
    if (key === 'mentioned') return issue.mentioned === true;
    if (key === 'contains') return normalize(`${issue.title} ${issue.body}`).includes(normalize(expected as string));
    const actual = issue[key as keyof Issue];
    if (typeof actual !== 'string') return false;
    if (key === 'path') return actual === expected;
    if (key === 'channel') return normalize(actual).replace(/^#/, '') === normalize(expected as string).replace(/^#/, '');
    return normalize(actual) === normalize(expected as string);
  });
}
