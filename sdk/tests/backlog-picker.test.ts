import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import {
  packageFromEntry,
  renderWorkPackage,
  selectBacklogEntry,
} from '../src/backlog-picker.js';

const BACKLOG = `# Backlog

Some preamble that is not an entry.

- **First actionable entry** the thing to do
  with a continuation line

- **Second entry** should not be chosen
`;

async function validate(input: unknown) {
  const picker = (await import('../src/backlog-picker.js')) as Record<string, unknown>;
  return (picker['validateWorkPackage'] as (value: unknown) => unknown)(input);
}

describe('backlog picker', () => {
  it('selects the first bold top-level bullet', () => {
    const entry = selectBacklogEntry(BACKLOG);
    expect(entry?.title).toBe('First actionable entry');
    expect(entry?.body).toContain('with a continuation line');
  });

  it('is DETERMINISTIC — identical input selects identically, every time', () => {
    // This is the property the flow exists to guarantee and the one the PR
    // claimed without testing. A Garden whose selection can drift gives
    // nothing downstream a stable thing to reason about.
    const runs = Array.from({ length: 25 }, () => selectBacklogEntry(BACKLOG));
    const first = JSON.stringify(runs[0]);
    for (const run of runs) {
      expect(JSON.stringify(run)).toBe(first);
    }
  });

  it('renders the same work package for the same entry', () => {
    const entry = selectBacklogEntry(BACKLOG);
    expect(entry).not.toBeNull();
    expect(renderWorkPackage(entry!)).toBe(renderWorkPackage(entry!));
  });

  it('returns null rather than guessing when nothing is actionable', () => {
    expect(selectBacklogEntry('# Backlog\n\nnothing here\n')).toBeNull();
    expect(selectBacklogEntry('- plain bullet, no bold title\n')).toBeNull();
  });

  it('ignores bold text that is not a top-level bullet title', () => {
    const md = 'Some **bold prose** in a paragraph.\n\n- **Real entry** yes\n';
    expect(selectBacklogEntry(md)?.title).toBe('Real entry');
  });

  it('does not treat backticked prose containing a slash as a file in scope', () => {
    const flowPath = join(__dirname, '..', '..', 'testdata', 'backlog-picker.flow.yaml');
    const flow = load(readFileSync(flowPath, 'utf8')) as {
      steps: Array<{ id: string; command: string }>;
    };
    const command = flow.steps.find((step) => step.id === 'emit-package')?.command;
    expect(command).toBeDefined();

    const dir = mkdtempSync(join(tmpdir(), 'backlog-picker-paths-'));
    try {
      mkdirSync(join(dir, '.relayflow'));
      writeFileSync(
        join(dir, '.relayflow', 'backlog-picker-entry.json'),
        JSON.stringify({
          title: 'Fix gate 3',
          body: 'Update `src/file.ts`; prose that contains `/` is not a path, and `the scope is parsed` is the goal.',
        }),
      );

      const output = execFileSync('sh', ['-c', command!], {
        cwd: dir,
        encoding: 'utf8',
        // Steps run in a throwaway cwd; point them at the real built SDK.
        env: { ...process.env, RELAYFLOWS_SDK_DIST: join(__dirname, '..', 'dist') },
      });
      const workPackage = JSON.parse(output) as { files_in_scope: string[] };
      expect(workPackage.files_in_scope).toEqual(['src/file.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('work package validation', () => {
  it('refuses an entry with unterminated backticks using a typed reason', async () => {
    const work = packageFromEntry({
      title: 'Fix malformed scope extraction',
      body: 'Update `sdk/src/backlog-picker.ts so scope cannot be mispaired.',
    });

    expect(await validate(work)).toEqual({
      accepted: false,
      reason: 'unterminated_backticks',
    });
  });

  it('uses a referenced code symbol as evidence of repository scope', async () => {
    const work = packageFromEntry({
      title: 'Refuse an entry with unterminated backticks',
      body: 'Update `validateWorkPackage` to return a typed refusal for malformed input.',
    });

    expect(await validate(work)).toMatchObject({
      accepted: true,
      work: {
        files_in_scope: ['.'],
        definition_of_done: ['Refuse an entry with unterminated backticks'],
      },
    });
  });

  it('keeps at least twenty real backlog entries actionable', async () => {
    const backlog = readFileSync(join(__dirname, '..', '..', 'ops', 'BACKLOG.md'), 'utf8');
    const entries = [...backlog.matchAll(/^- \*\*(.+?)\*\*\s*(.*(?:\n  .*)*)/gm)].map(
      (match) => ({
        title: match[1] ?? '',
        body: (match[2] ?? '').replace(/\s+/g, ' ').trim(),
      }),
    );
    const verdicts = await Promise.all(entries.map((entry) => validate(packageFromEntry(entry))));

    const actionable = verdicts.filter(
      (verdict) => (verdict as { accepted: boolean }).accepted,
    ).length;
    expect(actionable).toBeGreaterThanOrEqual(20);
  });

  it('accepts an engineering task stated as an imperative outcome', async () => {
    const work = packageFromEntry({
      title: 'Refuse a path-like deterministic command word',
      body: 'Update `sdk/src/preflight.ts` so a missing path is refused.',
    });

    expect(await validate(work)).toMatchObject({
      accepted: true,
      work: {
        files_in_scope: ['sdk/src/preflight.ts'],
        definition_of_done: ['Refuse a path-like deterministic command word'],
      },
    });
  });

  it('refuses a dated notes blob even when identifiers look actionable', async () => {
    const work = packageFromEntry({
      title: 'Upstream issues (2026-08-27):',
      body: 'relay#1620 (`--daemon` crash + `worker status` blind). Acceptance: `regressions/`.',
    });

    expect(await validate(work)).toEqual({
      accepted: false,
      reason: 'missing_definition_of_done',
    });
  });

  it('accepts a package yielded by an actionable backlog', async () => {
    const entry = selectBacklogEntry(
      '# Backlog\n\n- **Validate packages** edit `sdk/src/backlog-picker.ts`; run `npm test`\n',
    );

    expect(
      await validate({
        title: entry?.title,
        files_in_scope: ['sdk/src/backlog-picker.ts'],
        definition_of_done: ['npm test'],
      }),
    ).toEqual({
      accepted: true,
      work: {
        title: 'Validate packages',
        files_in_scope: ['sdk/src/backlog-picker.ts'],
        definition_of_done: ['npm test'],
      },
    });
  });

  it('refuses a package yielded by an unverifiable backlog', async () => {
    const entry = selectBacklogEntry('# Backlog\n\n- **Vague package** improve the SDK\n');

    expect(
      await validate({ files_in_scope: ['sdk/src/'], definition_of_done: ['npm test'] }),
    ).toEqual({ accepted: false, reason: 'missing_title' });
    expect(
      await validate({
        title: '   ',
        files_in_scope: ['sdk/src/'],
        definition_of_done: ['npm test'],
      }),
    ).toEqual({ accepted: false, reason: 'missing_title' });
    expect(
      await validate({ title: entry?.title, definition_of_done: ['npm test'] }),
    ).toEqual({ accepted: false, reason: 'missing_scope' });
    expect(
      await validate({ title: entry?.title, files_in_scope: [], definition_of_done: [] }),
    ).toEqual({ accepted: false, reason: 'missing_scope' });
    expect(
      await validate({ title: entry?.title, files_in_scope: ['sdk/src/'] }),
    ).toEqual({ accepted: false, reason: 'missing_definition_of_done' });
    expect(
      await validate({
        title: entry?.title,
        files_in_scope: ['sdk/src/'],
        definition_of_done: [],
      }),
    ).toEqual({ accepted: false, reason: 'missing_definition_of_done' });
  });

  it('refuses an empty backlog with a typed reason', async () => {
    const entry = selectBacklogEntry('# Backlog\n');

    expect(await validate(entry)).toEqual({ accepted: false, reason: 'missing_title' });
  });
});
