import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { load } from 'js-yaml';
import { describe, expect, it } from 'vitest';
import { renderWorkPackage, selectBacklogEntry } from '../src/backlog-picker.js';

const BACKLOG = `# Backlog

Some preamble that is not an entry.

- **First actionable entry** the thing to do
  with a continuation line

- **Second entry** should not be chosen
`;

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
          body: 'Update `src/file.ts`; prose that contains `/` is not a path.',
        }),
      );

      const output = execFileSync('sh', ['-c', command!], { cwd: dir, encoding: 'utf8' });
      const workPackage = JSON.parse(output) as { files_in_scope: string[] };
      expect(workPackage.files_in_scope).toEqual(['src/file.ts']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
