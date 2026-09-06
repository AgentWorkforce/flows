import { describe, expect, it } from 'vitest';
import { consumeWorkPackage } from '../src/work-package-consumer.js';

const validPackage = {
  title: 'Build the work package consumer',
  files_in_scope: ['sdk/src/', 'sdk/tests/'],
  definition_of_done: ['cd sdk && npm test'],
};

async function consume(input: unknown) {
  const module = await import('../src/work-package-consumer.js');
  // Inject a permissive existence check: these tests exercise the OTHER
  // refusal reasons, and should not also depend on whether fixture paths
  // happen to exist on disk.
  return module.consumeWorkPackage(input, () => true);
}

describe('work package consumer', () => {
  it('refuses a missing title with a typed reason', async () => {
    const { title: _, ...input } = validPackage;
    expect(await consume(input)).toEqual({ accepted: false, reason: 'missing_title' });
  });

  it('refuses an empty title with a typed reason', async () => {
    expect(await consume({ ...validPackage, title: '   ' })).toEqual({
      accepted: false,
      reason: 'missing_title',
    });
  });

  it('refuses a missing scope with a typed reason', async () => {
    const { files_in_scope: _, ...input } = validPackage;
    expect(await consume(input)).toEqual({ accepted: false, reason: 'missing_scope' });
  });

  it('refuses an empty scope with a typed reason', async () => {
    expect(await consume({ ...validPackage, files_in_scope: [] })).toEqual({
      accepted: false,
      reason: 'missing_scope',
    });
  });

  it('refuses a missing definition of done with a typed reason', async () => {
    const { definition_of_done: _, ...input } = validPackage;
    expect(await consume(input)).toEqual({
      accepted: false,
      reason: 'missing_definition_of_done',
    });
  });

  it('refuses an empty definition of done with a typed reason', async () => {
    expect(await consume({ ...validPackage, definition_of_done: [] })).toEqual({
      accepted: false,
      reason: 'missing_definition_of_done',
    });
  });

  it('accepts a valid package as runnable work', async () => {
    expect(await consume(validPackage)).toEqual({ accepted: true, work: validPackage });
  });
});

describe('the Garden join: picker output feeds the consumer', () => {
  it('accepts a package the picker actually emits, and refuses one lacking a definition of done', () => {
    // Review found the two halves did not fit (PR #23, P1): the picker emitted
    // {title, description, files_in_scope, gate} and the consumer required
    // definition_of_done, which the picker never produced — so the consumer
    // would have refused EVERY real package and the loop could never accept
    // anything. This test runs the flow's actual emit-package command so the
    // shapes cannot drift apart again without failing here.
    const { execFileSync } = require('node:child_process') as typeof import('node:child_process');
    const { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } = require('node:fs') as typeof import('node:fs');
    const { tmpdir } = require('node:os') as typeof import('node:os');
    const { join } = require('node:path') as typeof import('node:path');
    const { load } = require('js-yaml') as typeof import('js-yaml');

    const flowPath = join(__dirname, '..', '..', '..', 'testdata', 'backlog-picker.flow.yaml');
    const flow = load(readFileSync(flowPath, 'utf8')) as { steps: Array<{ id: string; command: string }> };
    const step = (id: string) => flow.steps.find((s) => s.id === id)!.command;
    // stdio: stderr captured, not echoed -- see backlog-picker-flow.test.ts.
    const run = (cmd: string, cwd: string) => execFileSync('sh', ['-c', cmd], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, RELAYFLOWS_SDK_DIST: join(__dirname, '..', 'dist') }, });

    const dir = mkdtempSync(join(tmpdir(), 'garden-join-'));
    try {
      mkdirSync(join(dir, 'ops'), { recursive: true });

      // An entry carrying a runnable command: that IS its definition of done.
      writeFileSync(
        join(dir, 'ops', 'BACKLOG.md'),
        '# Backlog\n\n- **Actionable entry** touches `sdk/src/x.ts`, verified by `npm test --silent`\n',
      );
      run(step('read-backlog'), dir);
      run(step('select-entry'), dir);
      const accepted = JSON.parse(run(step('emit-package'), dir));
      expect(consumeWorkPackage(accepted, () => true).accepted, JSON.stringify(accepted)).toBe(true);

      // An entry with no command names no way to verify itself. The refusal
      // now happens EARLIER than it used to: PR #30 review required the flow
      // to actually call the validator, so `select-entry` rejects an
      // unactionable entry rather than letting emit-package hand a package
      // nobody can act on to the consumer. Assert where the guard now lives.
      writeFileSync(
        join(dir, 'ops', 'BACKLOG.md'),
        '# Backlog\n\n- **Scoped but unverifiable** touches `sdk/src/y.ts` but names no command\n',
      );
      run(step('read-backlog'), dir);
      let selectionRefused = '';
      try {
        run(step('select-entry'), dir);
      } catch (error) {
        selectionRefused = String((error as { stderr?: Buffer }).stderr ?? error);
      }
      expect(selectionRefused, 'select-entry must refuse an entry with no definition of done').toContain(
        'missing_definition_of_done',
      );

      // The consumer remains the second line of defence: if such a package
      // ever reaches it by another route, it still refuses with the same
      // typed reason.
      const verdict = consumeWorkPackage(
        {
          title: 'Scoped but unverifiable',
          description: 'touches `sdk/src/y.ts` but names no command',
          files_in_scope: ['sdk/src/y.ts'],
          definition_of_done: [],
        },
        () => true,
      );
      expect(verdict.accepted).toBe(false);
      expect(verdict.accepted === false && verdict.reason).toBe('missing_definition_of_done');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('scope existence', () => {
  const scoped = {
    title: 'Real entry',
    files_in_scope: ['sdk/src/a.ts', 'sdk/src/b.ts'],
    definition_of_done: ['npm test'],
  };

  it('refuses a package scoping files that do not exist', () => {
    // The picker derives files_in_scope from prose in ops/BACKLOG.md, so a
    // stale or mistyped entry yields a package that reads as actionable and
    // sends whoever picks it up hunting for a file that was never there.
    const verdict = consumeWorkPackage(scoped, () => false);
    expect(verdict.accepted).toBe(false);
    expect(verdict.accepted === false && verdict.reason).toBe('nonexistent_files');
  });

  it('refuses when only some scoped files exist', () => {
    const verdict = consumeWorkPackage(scoped, (p) => p === 'sdk/src/a.ts');
    expect(verdict.accepted).toBe(false);
    expect(verdict.accepted === false && verdict.reason).toBe('nonexistent_files');
  });

  it('accepts when every scoped file exists', () => {
    expect(consumeWorkPackage(scoped, () => true).accepted).toBe(true);
  });

  it('checks the real filesystem when no checker is injected', () => {
    // Review rejected making this opt-in (PR #28, P1): a caller using the
    // one-argument API would silently skip the check, so the guard would not
    // guard. The default must reach the filesystem — these paths do not exist,
    // so the package is refused without anyone passing a checker.
    const verdict = consumeWorkPackage(scoped);
    expect(verdict.accepted).toBe(false);
    expect(verdict.accepted === false && verdict.reason).toBe('nonexistent_files');
  });

  it('accepts a package scoping files that really are present', () => {
    // Injection exists to make the check testable, not to disable it.
    const real = { ...scoped, files_in_scope: ['package.json'] };
    expect(consumeWorkPackage(real).accepted).toBe(true);
  });
});
