import { describe, expect, it } from 'vitest';
import { consumeWorkPackage } from '../src/work-package-consumer.js';

const validPackage = {
  title: 'Build the work package consumer',
  files_in_scope: ['sdk/src/', 'sdk/tests/'],
  definition_of_done: ['cd sdk && npm test'],
};

async function consume(input: unknown) {
  const module = await import('../src/work-package-consumer.js');
  return module.consumeWorkPackage(input);
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

    const flowPath = join(__dirname, '..', '..', 'testdata', 'backlog-picker.flow.yaml');
    const flow = load(readFileSync(flowPath, 'utf8')) as { steps: Array<{ id: string; command: string }> };
    const step = (id: string) => flow.steps.find((s) => s.id === id)!.command;
    const run = (cmd: string, cwd: string) => execFileSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' });

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
      expect(consumeWorkPackage(accepted).accepted, JSON.stringify(accepted)).toBe(true);

      // An entry with no command names no way to verify itself.
      writeFileSync(
        join(dir, 'ops', 'BACKLOG.md'),
        '# Backlog\n\n- **Scoped but unverifiable** touches `sdk/src/y.ts` but names no command\n',
      );
      run(step('read-backlog'), dir);
      run(step('select-entry'), dir);
      const refused = JSON.parse(run(step('emit-package'), dir));
      const verdict = consumeWorkPackage(refused);
      expect(verdict.accepted).toBe(false);
      expect(verdict.accepted === false && verdict.reason).toBe('missing_definition_of_done');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
