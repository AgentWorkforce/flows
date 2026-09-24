import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { getFlowDefinition } from '@relayflows/surface/runtime';
import softwareFactory from '../../../examples/software-factory/software-factory.flow.ts';

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(dir => rmSync(dir, { recursive: true, force: true })));

type Issue = {
  source: string;
  title: string;
  body: string;
  labels: string[];
  identifier?: string;
  url?: string;
};

function runCanonical(issue: Issue, summary = '## Summary\n\nImplemented the ticket.\n') {
  const root = mkdtempSync(join(tmpdir(), 'canonical-factory-metadata-'));
  dirs.push(root);
  execFileSync('git', ['init', '-q'], { cwd: root });
  const bin = join(root, 'bin');
  const capture = join(root, 'gh.args');
  mkdirSync(bin);
  writeFileSync(join(bin, 'gh'), '#!/bin/sh\nprintf \'%s\\n\' "$@" > "$GH_CAPTURE"\n', { mode: 0o755 });
  chmodSync(join(bin, 'gh'), 0o755);

  const commands: string[] = [];
  let completionReason = '';
  const shell = (command: string) => execFileSync('/bin/sh', ['-c', command], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}`, GH_CAPTURE: capture },
  });
  const context = {
    async run(command: string) {
      commands.push(command);
      if (command.startsWith('rm -rf .relayflow')) return shell(command);
      if (command.startsWith('if [ -f package.json ]')) return '';
      if (command.startsWith('if [ -f .relayflow/review.passed ]')) return shell(command);
      if (command.startsWith('git add -A')) return '';
      if (command === 'git remote get-url origin') return 'git@github.com:AgentWorkforce/cloud.git\n';
      if (command === 'git rev-parse HEAD') return `${'a'.repeat(40)}\n`;
      if (command.includes('> .relayflow/pr-body.md') || command.startsWith('cp .relayflow/summary.md')) return shell(command);
      if (command.startsWith('reference=') || command.startsWith('title=')) return shell(command);
      if (command === 'git push --set-upstream origin HEAD') return 'pushed\n';
      if (command.startsWith('gh pr create')) return shell(command);
      return '';
    },
    agent(name: string) {
      return {
        async gate() {
          if (name === 'implementer') writeFileSync(join(root, '.relayflow/summary.md'), summary);
          if (name === 'adversary') {
            writeFileSync(join(root, '.relayflow/review.md'), 'No blocking findings.\n');
            writeFileSync(join(root, '.relayflow/review.passed'), 'passed\n');
          }
          return {};
        },
      };
    },
    async hook() { return true; },
    done(reason: string) { completionReason = reason; },
  };

  const definition = getFlowDefinition(softwareFactory);
  return definition.body(context as never, { issue, approver: 'khaliq' }).then(() => ({
    root,
    commands,
    completionReason,
    ghArgs: existsSync(capture) ? readFileSync(capture, 'utf8').trim().split('\n') : [],
    body: existsSync(join(root, '.relayflow/pr-body.md'))
      ? readFileSync(join(root, '.relayflow/pr-body.md'), 'utf8')
      : '',
  }));
}

describe('canonical software-factory metadata contract', () => {
  it('opens the actual catalog flow with the ticket title and exactly one GitHub closing line', async () => {
    const title = 'Ambiguous create failures leak sandboxes: every retry uses a new name';
    const result = await runCanonical({
      source: 'github', title, body: 'Retrying an ambiguous create can leak a sandbox.', labels: ['garden-ready'],
      identifier: '#3913', url: 'https://github.com/AgentWorkforce/cloud/issues/3913',
    });

    expect(result.completionReason).toBe('success');
    expect(result.ghArgs).toEqual(['pr', 'create', '--title', title, '--body-file', '.relayflow/pr-body.md']);
    expect(result.body.split('\n').filter(line => line === 'Fixes #3913')).toHaveLength(1);
    const validate = result.commands.findIndex(command => command.startsWith('title='));
    const push = result.commands.indexOf('git push --set-upstream origin HEAD');
    const open = result.commands.findIndex(command => command.startsWith('gh pr create'));
    expect(validate).toBeGreaterThan(-1);
    expect(validate).toBeLessThan(push);
    expect(push).toBeLessThan(open);
  });

  it('writes a Linear closing reference that the GitHub integration links back', async () => {
    const result = await runCanonical({
      source: 'linear', title: 'Rate-limit the webhook queue', body: 'Per-connection 429 budget.', labels: ['agent'],
      identifier: 'TECH-42', url: 'https://linear.app/wepost/issue/TECH-42',
    });
    expect(result.completionReason).toBe('success');
    expect(result.body.split('\n').filter(line => line === 'Fixes TECH-42')).toHaveLength(1);
  });

  it('accepts a Linear team key that carries digits', async () => {
    const result = await runCanonical({
      source: 'linear', title: 'Rate-limit the webhook queue', body: 'body', labels: [],
      identifier: 'PLA4-42', url: 'https://linear.app/wepost/issue/PLA4-42',
    });
    expect(result.completionReason).toBe('success');
    expect(result.body.split('\n').filter(line => line === 'Fixes PLA4-42')).toHaveLength(1);
  });

  it.each(['', 'not-an-issue'])(
    'stops before push when a Linear ticket has no linkable identifier (%s)',
    async (identifier) => {
      const result = await runCanonical({
        source: 'linear', title: 'Rate-limit the webhook queue', body: 'body', labels: [],
        identifier, url: 'https://linear.app/wepost/issue/TECH-42',
      });
      expect(result.completionReason).toBe('needs_human');
      expect(result.commands.some(command => command.startsWith('git push') || command.startsWith('gh pr create'))).toBe(false);
    },
  );

  it('fails closed before push when the Linear closing reference is duplicated in the final body', async () => {
    // The summary is written by the implementer; a body that repeats the
    // closing line must stop the run rather than ship a doubled reference.
    const result = await runCanonical({
      source: 'linear', title: 'Rate-limit the webhook queue', body: 'body', labels: [],
      identifier: 'TECH-42',
    }, '## Summary\n\nFixes TECH-42\n\nFixes TECH-42\n');
    expect(result.completionReason).toBe('needs_human');
    expect(result.commands.some(command => command.startsWith('git push') || command.startsWith('gh pr create'))).toBe(false);
  });

  it('fails closed before push when the body carries a foreign closing reference', async () => {
    // A summary naming a different ticket would auto-link the pull request to
    // the wrong issue on merge. PREPARE appends the expected line, leaving two
    // closing-keyword lines — the run must stop rather than ship both.
    const result = await runCanonical({
      source: 'linear', title: 'Rate-limit the webhook queue', body: 'body', labels: [],
      identifier: 'TECH-42',
    }, '## Summary\n\nFixes OTHER-9\n');
    expect(result.completionReason).toBe('needs_human');
    expect(result.commands.some(command => command.startsWith('git push') || command.startsWith('gh pr create'))).toBe(false);
  });

  it('normalizes whitespace and caps the title at 240 Unicode code points', async () => {
    const result = await runCanonical({
      source: 'github', title: `  Repair   ${'修'.repeat(250)}  `, body: 'body', labels: [], identifier: '#7',
    });
    const title = result.ghArgs[result.ghArgs.indexOf('--title') + 1]!;
    expect(title.startsWith('Repair 修')).toBe(true);
    expect(Array.from(title)).toHaveLength(240);
  });

  it('fails closed before push when GitHub identity is missing or the final body duplicates its closing line', async () => {
    const definition = getFlowDefinition(softwareFactory);
    const commands: string[] = [];
    let completionReason = '';
    await definition.body({
      run: async (command: string) => { commands.push(command); return ''; },
      done: (reason: string) => { completionReason = reason; },
    } as never, {
      issue: { source: 'github', title: 'Fix login', body: 'body', labels: [] }, approver: 'khaliq',
    });
    expect(completionReason).toBe('needs_human');
    expect(commands.some(command => command.startsWith('git push') || command.startsWith('gh pr create'))).toBe(false);

    const duplicate = await runCanonical({
      source: 'github', title: 'Fix login', body: 'body', labels: [], identifier: '#507',
    }, '## Summary\n\nFixes #507\n\nFixes #507\n');
    expect(duplicate.completionReason).toBe('needs_human');
    expect(duplicate.commands.some(command => command.startsWith('git push') || command.startsWith('gh pr create'))).toBe(false);
  });
});
