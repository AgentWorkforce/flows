import { describe, expect, it } from 'vitest';
import { matchesIssue, type Issue, type IssueSource, type SourceFilters } from '../src/issues.js';

const issue = (source: IssueSource, fields: Partial<Issue> = {}): Issue => ({
  source, title: 'Please fix login', body: 'Fails on mobile', labels: [' Bug ', 'READY'], ...fields,
});

describe('matchesIssue', () => {
  it.each<IssueSource>(['github', 'linear', 'shortcut', 'jira', 'slack', 'markdown'])(
    'accepts an empty filter only for the enabled %s source', source => {
      expect(matchesIssue(issue(source), { [source]: {} })).toBe(true);
      expect(matchesIssue(issue(source), {})).toBe(false);
    },
  );

  it.each<{ source: IssueSource; fields: Partial<Issue>; filters: SourceFilters }>([
    { source: 'github', fields: { repository: ' Owner/Repo ' }, filters: { github: { repository: 'owner/repo', labels: ['bug', ' ready '] } } },
    { source: 'linear', fields: { team: 'Engineering', project: ' Web ' }, filters: { linear: { team: ' engineering ', project: 'web', labels: ['bug'] } } },
    { source: 'shortcut', fields: { workspace: 'Product', project: 'Web' }, filters: { shortcut: { workspace: ' product ', project: 'WEB', labels: ['ready'] } } },
    { source: 'jira', fields: { project: 'ENG' }, filters: { jira: { project: ' eng ', labels: ['bug'] } } },
    { source: 'slack', fields: { channel: '#Engineering', mentioned: true }, filters: { slack: { channel: ' engineering ', contains: ' FIX LOGIN ', mentioned: true } } },
    { source: 'markdown', fields: { path: 'Tasks.md' }, filters: { markdown: { path: 'Tasks.md' } } },
  ])('matches normalized identifiers and configured filters for $source', ({ source, fields, filters }) => {
    expect(matchesIssue(issue(source, fields), filters)).toBe(true);
  });

  it('requires every label and every configured field, allowing extra labels', () => {
    const input = issue('linear', { team: 'Engineering', project: 'Web' });
    expect(matchesIssue(input, { linear: { team: 'Engineering', project: 'Mobile' } })).toBe(false);
    expect(matchesIssue(input, { linear: { labels: ['bug', 'missing'] } })).toBe(false);
    expect(matchesIssue(input, { linear: { labels: [] } })).toBe(true);
    expect(matchesIssue(input, { linear: { team: 'Engineering', labels: ['bug'] } })).toBe(true);
    expect(matchesIssue(issue('linear'), { linear: { team: 'Engineering' } })).toBe(false);
  });

  it('matches contains against title and body together, with normalized whitespace and case', () => {
    expect(matchesIssue(issue('slack'), { slack: { contains: ' LOGIN FAILS ' } })).toBe(true);
    expect(matchesIssue(issue('slack'), { slack: { contains: 'missing' } })).toBe(false);
  });

  it('accepts optional channel hashes on either side, but not a different channel', () => {
    expect(matchesIssue(issue('slack', { channel: ' Engineering ' }), { slack: { channel: ' #engineering ' } })).toBe(true);
    expect(matchesIssue(issue('slack', { channel: '#general' }), { slack: { channel: 'engineering' } })).toBe(false);
  });

  it('requires an explicit true mention flag only when configured', () => {
    for (const mentioned of [undefined, false]) {
      expect(matchesIssue(issue('slack', { mentioned }), { slack: { mentioned: true } })).toBe(false);
      expect(matchesIssue(issue('slack', { mentioned }), { slack: {} })).toBe(true);
    }
    expect(matchesIssue(issue('slack', { mentioned: true }), { slack: { mentioned: true } })).toBe(true);
  });

  it('matches paths exactly, including case and whitespace', () => {
    for (const path of ['tasks.md', ' Tasks.md', 'Tasks.md ', './Tasks.md']) {
      expect(matchesIssue(issue('markdown', { path }), { markdown: { path: 'Tasks.md' } })).toBe(false);
    }
  });

  it('rejects malformed input without throwing', () => {
    const invalid = [null, undefined, [], 'issue', 3, true, {},
      { ...issue('linear'), source: 'other' },
      { ...issue('linear'), title: null },
      { ...issue('linear'), body: 1 },
      { ...issue('linear'), labels: 'bug' },
      { ...issue('linear'), labels: [1] },
      { ...issue('linear'), labels: new Array(1) },
      { ...issue('linear'), team: 1 },
      { ...issue('linear'), mentioned: 'true' },
    ];
    for (const input of invalid) expect(matchesIssue(input, { linear: {} })).toBe(false);
  });

  it('rejects malformed configuration, including rules on unused sources', () => {
    const invalid = [null, undefined, [], true, 'linear', new Date(),
      { linear: undefined }, { linear: null }, { linear: [] }, { linear: new Date() },
      { linear: { labels: 'bug' } }, { linear: { labels: [1] } },
      { linear: { labels: new Array(1) } }, { linear: { team: false } },
      { linear: { team: undefined } }, { linear: { channel: 'engineering' } },
      { linear: {}, unknown: {} }, { linear: {}, slack: { mentioned: false } },
      { linear: {}, slack: { mentioned: 'true' } },
      { linear: {}, [Symbol('unknown')]: {} },
    ];
    for (const filters of invalid) expect(matchesIssue(issue('linear'), filters as SourceFilters)).toBe(false);
  });

  it('does not accept inherited providers or silently ignore inherited constraints', () => {
    for (const source of ['toString', 'constructor', '__proto__']) {
      expect(matchesIssue({ ...issue('linear'), source }, { linear: {} })).toBe(false);
    }
    expect(matchesIssue(issue('linear'), Object.create({ linear: {} }))).toBe(false);
    expect(matchesIssue(issue('linear'), { linear: Object.create({ team: 'other' }) })).toBe(false);
    const filters = Object.assign(Object.create(null), { linear: {} });
    expect(matchesIssue(issue('linear'), filters)).toBe(true);
    const settings = Object.defineProperty({}, 'team', { value: 'other' });
    expect(matchesIssue(issue('linear'), { linear: settings })).toBe(false);
  });

  it('narrows unknown input without modifying it or the configuration', () => {
    const input: unknown = Object.freeze(issue('github', { labels: Object.freeze(['bug']) as unknown as string[] }));
    const filters = Object.freeze({ github: Object.freeze({ labels: Object.freeze(['bug']) }) });
    if (!matchesIssue(input, filters)) throw new Error('Expected a valid issue');
    const narrowed: Issue = input;
    expect(narrowed.title).toBe('Please fix login');
    expect(input.labels).toEqual(['bug']);
  });
});

// Compiled by tsconfig.test.json; these configurations must remain invalid.
function invalidFilters(): void {
  // @ts-expect-error GitHub does not have a team filter
  matchesIssue({}, { github: { team: 'Engineering' } });
  // @ts-expect-error labels are arrays, not comma-separated UI input
  matchesIssue({}, { linear: { labels: 'bug, ready' } });
  // @ts-expect-error omit mentioned to accept messages without a mention
  matchesIssue({}, { slack: { mentioned: false } });
  // @ts-expect-error unknown providers cannot enable issue intake
  matchesIssue({}, { other: {} });
}
void invalidFilters;
