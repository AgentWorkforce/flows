import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { runCli } from '../src/cli.js';
import { checkFlow } from '../src/cli/check.js';
import { foldUnprovableEffects } from '../src/cli/diagnostic-fold.js';

const fixture = fileURLToPath(new URL('../../../testdata/preflight/unprovable-many.flow.yaml', import.meta.url));
const warning = (stepId?: string) => ({ severity: 'warning', kind: 'unprovable_effects', message: `effects ${stepId}`, ...(stepId === undefined ? {} : { stepId }) });
const three = [warning('a'), warning('b'), warning('c')];
const summary = 'WARNING [unprovable_effects] 3 of 4 steps have effects that cannot be proven before execution (rerun with --explain-warnings to list them).';
const unresolved = 'WARNING [command_unresolved] Step "suspicious" command "definitely-not-a-real-binary" does not resolve as an executable; it runs only if the shell supplies it.';
const details = [
  'WARNING [unprovable_effects] Step "first" command "printf" resolves, but its effects cannot be proven before execution.',
  'WARNING [unprovable_effects] Step "second" command "printf" resolves, but its effects cannot be proven before execution.',
  'WARNING [unprovable_effects] Step "conditional" starts with the shell reserved word "if", whose effects cannot be proven before execution.',
];
async function invoke(args: string[]) {
  const stdout: string[] = [], stderr: string[] = [];
  const code = await runCli(args, { stdout: line => stdout.push(line), stderr: line => stderr.push(line) });
  return { stdout, stderr, code };
}

describe('warning folding', () => {
  it('is opt-in and explain restores the original array', () => {
    expect(foldUnprovableEffects(three)).toBe(three);
    expect(foldUnprovableEffects(three, {})).toBe(three);
    expect(foldUnprovableEffects(three, { fold: true, explain: true })).toBe(three);
  });
  it('keeps zero, single, and duplicate-step warnings verbatim', () => {
    for (const input of [[], [warning('a')], [warning('a'), warning('a')]]) {
      expect(foldUnprovableEffects(input, { fold: true })).toBe(input);
    }
  });
  it('counts distinct steps and each warning without a step, without mutating input', () => {
    const other = { severity: 'warning', kind: 'command_unresolved', message: 'missing' };
    const input = Object.freeze([warning('a'), other, warning('a'), warning(), warning()]);
    expect(foldUnprovableEffects(input, { fold: true, totalSteps: 58 })).toEqual([
      other, { severity: 'warning', kind: 'unprovable_effects', message: '3 of 58 steps have effects that cannot be proven before execution (rerun with --explain-warnings to list them).' },
    ]);
    expect(foldUnprovableEffects(three, { fold: true })[0]?.message).toBe('3 steps have effects that cannot be proven before execution (rerun with --explain-warnings to list them).');
  });
});

describe('flows check warning presentation', () => {
  it('puts the suspicious command ahead of one summary', async () => {
    const result = await invoke(['check', fixture]);
    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([unresolved, summary]);
  });
  it('explains each step in original order', async () => {
    const result = await invoke(['check', '--explain-warnings', fixture]);
    expect(result.code).toBe(0);
    expect(result.stderr).toEqual([...details, unresolved]);
  });
  it('keeps JSON byte-identical to the original report, with either text mode', async () => {
    const expected = JSON.stringify(checkFlow(fixture, { warnUnresolvedAgentWorker: true }).report);
    for (const flags of [[], ['--explain-warnings']]) {
      const result = await invoke(['check', '--json', ...flags, fixture]);
      expect(result.code).toBe(0);
      expect(result.stdout).toEqual([expected]);
      expect(result.stderr).toEqual(flags.length ? [...details, unresolved] : [unresolved, summary]);
      expect(JSON.parse(result.stdout[0]!).diagnostics.filter((d: { kind: string }) => d.kind === 'unprovable_effects')).toHaveLength(3);
    }
  });
  it.each([
    ['run', '--explain-warnings', fixture],
    ['resume', '--explain-warnings', 'run-id'],
    ['check', '--explain-warnings', '--explain-warnings', fixture],
  ])('refuses invalid flag use: %j', async (...args) => {
    const result = await invoke(args);
    expect(result.code).toBe(2);
    expect(result.stderr[0]).toContain('REFUSED [invalid_invocation]');
  });
  it('retains every run warning through the run renderer without a daemon', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'flows-warning-run-'));
    try {
      const result = await invoke(['run', '--no-spawn', '--no-observer-link', '--data-dir', directory, fixture]);
      expect(result.code).toBe(2);
      expect(result.stderr.filter(line => line.startsWith('WARNING [unprovable_effects]'))).toEqual(details);
      expect(result.stderr.some(line => line.includes('daemon_unreachable'))).toBe(true);
    } finally { rmSync(directory, { recursive: true, force: true }); }
  });
  it.each([false, true])('forwards explain=%s to the watch child', async (explain) => {
    const entry = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
    const child = spawn(process.execPath, [entry, 'check', '--watch', ...(explain ? ['--explain-warnings'] : []), fixture]);
    const closed = once(child, 'close');
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    try {
      await expect.poll(() => stdout.includes('CHECK PASSED'), { timeout: 5000 }).toBe(true);
    } finally { child.kill('SIGINT'); await closed; }
    expect(stderr.trim().split('\n')).toEqual(explain ? [...details, unresolved] : [unresolved, summary]);
  });
});
