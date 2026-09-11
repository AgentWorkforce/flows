import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { flow } from '@relayflows/surface';
import closePr from '../scripts/dogfood/close-pr.flow.js';
import {
  analyzeFindings, checksCommand, parseChecks, parseInput, parsePrNumber, quote,
  type BotComment, type Check, type ClosePrInput, type ReviewThread,
} from '../scripts/dogfood/close-pr-state.js';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { runDirectFlow } from '../src/cli/direct-run.js';
import * as runOperations from '../src/cli/run.js';
import { JournalClient } from '../src/journal-client.js';
import type { KernelRunSpec, KernelStepSpec } from '../src/spec.js';

// The provider, agent and journal transport are fixtures; the authored executor,
// spec compiler, and per-effect journal reads run unchanged.
vi.mock('../src/cli/check.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/cli/check.js')>(),
  checkAuthoredFlow: (spec: unknown) => ({ report: { ok: true, diagnostics: [] }, flow: spec }),
}));

const green: Check[] = [
  { name: 'typecheck', bucket: 'pass', link: '', description: '' },
  { name: 'Cursor Bugbot', bucket: 'pass', link: '', description: '' },
];
const failed: Check = {
  name: 'typecheck', bucket: 'fail', description: 'TypeScript failed',
  link: 'https://github.com/acme/repo/actions/runs/42/job/3',
};
const finding: BotComment = {
  id: 12, user: { login: 'cursor[bot]' }, body: '**Medium Severity**\nNull access',
  path: 'src/app.ts', html_url: 'https://github.com/acme/repo/pull/7#discussion_r12',
};
const thread: ReviewThread = { commentId: 12, isResolved: false, isOutdated: false };
const baseInput: ClosePrInput = {
  worktree: '/tmp/slice worktree', repo: 'acme/repo', branch: 'feat/slice',
  title: 'Slice', cli: 'codex', model: 'test-model', pollIntervalSeconds: 1, maxPolls: 3,
};
interface Snapshot { checks: Check[]; comments?: BotComment[]; threads?: ReviewThread[] }

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  vi.restoreAllMocks();
});

async function harness(snapshots: Snapshot[], options: {
  existing?: boolean; input?: Partial<ClosePrInput>; changeHead?: boolean;
  malformedChecks?: boolean; mergeState?: string; failTerminal?: boolean;
} = {}) {
  const specs: KernelRunSpec[] = [];
  const entries = new Map<string, unknown>();
  const reads: string[] = [];
  let repairs = 0;
  let poll = -1;
  const input = { ...baseInput, ...options.input };
  const commands: string[] = [];
  const current = () => snapshots[Math.min(Math.max(0, poll), snapshots.length - 1)]!;
  const head = () => `head-${repairs}`;
  function output(step: KernelStepSpec): string {
    if (step.type === 'agent') { repairs += 1; return 'fixed'; }
    if (step.type !== 'deterministic' || typeof step.command !== 'string') throw new Error('Unexpected step');
    const command = step.command;
    commands.push(command);
    if (command.includes('$IMPL_CLOSE_INPUT')) return JSON.stringify(input);
    if (command.includes('git rev-parse HEAD')) return head();
    if (command.includes('gh pr list')) return options.existing ? '[{"number":7}]' : '[]';
    if (command.includes('gh pr create')) return 'https://github.com/acme/repo/pull/7\n';
    if (command.includes('--json headRefOid,headRefName,state')) {
      return JSON.stringify({ headRefOid: head(), headRefName: input.branch, state: 'OPEN' });
    }
    if (command.includes('gh pr checks')) {
      poll += 1;
      return options.malformedChecks ? '' : JSON.stringify(current().checks);
    }
    if (command.includes('/comments')) return JSON.stringify(current().comments ?? []);
    if (command.includes('gh api graphql')) return JSON.stringify(current().threads ?? []);
    if (command.includes('--jq .headRefOid')) return options.changeHead ? 'concurrent-head' : head();
    if (command.includes('gh run view')) return 'src/app.ts(1,1): error TS1005: syntax error';
    if (command.includes('--jq .state')) return options.mergeState ?? 'MERGED';
    return '';
  }
  const client = new JournalClient('/unused-in-memory-journal');
  vi.spyOn(client, 'runStart').mockImplementation(async spec => {
    specs.push(spec);
    const step = spec.steps[0]!;
    const id = `close-run-${specs.length}`;
    if (options.failTerminal && step.id.startsWith('complete-')) {
      throw new Error('journal_write_failed: disk full');
    }
    entries.set(id, {
      entry_type: 'step.completed', step_id: step.id,
      payload: { completionReason: 'success', output: { stdout_tail: output(step), exit_code: 0, stderr_tail: '' } },
    });
    return { run_id: id, status: 'completed', completion_reason: 'success', completed_steps: 1 };
  });
  vi.spyOn(client, 'journalRead').mockImplementation(async id => {
    reads.push(id);
    return { entries: [entries.get(id)] };
  });
  return {
    execute: () => executeAuthoredFlow(closePr, client), client, commands, specs, reads,
    agents: () => specs.flatMap(spec => spec.steps).filter(step => step.type === 'agent'),
  };
}

describe('close-pr journaled repair loop', () => {
  it('reads an existing Bugbot finding, repairs in the same worktree, pushes and re-verifies before merging', async () => {
    const h = await harness([
      { checks: green, comments: [finding], threads: [thread] },
      { checks: green, comments: [finding], threads: [{ ...thread, isResolved: true }] },
    ], { existing: true });
    const result = await h.execute();
    expect(result.completionReason).toBe('success');
    expect(h.commands.some(command => command.includes('gh pr create'))).toBe(false);
    expect(h.agents()).toHaveLength(1);
    expect(h.agents()[0]).toMatchObject({
      cli: 'codex', model: 'test-model', instruction: expect.stringContaining('Null access'),
      surfaces: { workspace: [{ surface: baseInput.worktree }] },
    });
    const push = h.commands.findIndex(command => command.includes('git push --force-with-lease'));
    const merge = h.commands.findIndex(command => command.includes('gh pr merge'));
    expect(push).toBeGreaterThan(0);
    expect(h.commands.slice(push + 1, merge).some(command => command.includes('gh pr checks'))).toBe(true);
    expect(h.commands[merge]).toContain("--match-head-commit 'head-1'");
    expect(h.commands.filter(command => command.includes('git commit -m'))).toHaveLength(1);
    expect(result.journalSteps).toHaveLength(h.specs.length);
    expect(new Set(result.journalSteps.map(step => step.id)).size).toBe(h.specs.length);
    expect(h.reads).toHaveLength(h.specs.length);
    expect(h.commands.filter(command => command.includes('/comments'))).toHaveLength(2);
  });

  it('opens a PR and feeds failed CI logs into the repair agent', async () => {
    const h = await harness([{ checks: [failed, green[1]!] }, { checks: green }]);
    expect((await h.execute()).completionReason).toBe('success');
    expect(h.commands.some(command => command.includes('gh pr create'))).toBe(true);
    expect(h.commands.some(command => command.includes('gh run view 42') && command.includes('--log-failed'))).toBe(true);
    expect(h.agents()[0]?.instruction).toContain('error TS1005: syntax error');
  });

  it('parks after exactly three nonconverging repairs, with accumulated blockers', async () => {
    const h = await harness([{ checks: [failed, green[1]!] }]);
    expect((await h.execute()).completionReason).toBe('needs_human');
    expect(h.agents()).toHaveLength(3);
    expect(h.commands.filter(command => command.includes('gh pr checks'))).toHaveLength(4);
    expect(h.commands.filter(command => command.includes('git push'))).toHaveLength(3);
    expect(h.commands.some(command => command.includes('gh pr merge'))).toBe(false);
    expect(h.commands.at(-2)).toContain('TypeScript failed');
    expect(h.commands.at(-2)).toContain('"iterations":3');
    expect(h.commands.at(-1)).toBe(`printf '%s' '{"completionReason":"needs_human"}'`);
  });

  it('can converge on the third repair', async () => {
    const h = await harness([
      { checks: [failed, green[1]!] }, { checks: [failed, green[1]!] },
      { checks: [failed, green[1]!] }, { checks: green },
    ]);
    expect((await h.execute()).completionReason).toBe('success');
    expect(h.agents()).toHaveLength(3);
  });

  it('polls pending checks without spending repair attempts or reading incomplete logs', async () => {
    const h = await harness([
      { checks: [] }, { checks: [failed, { ...green[1]!, bucket: 'pending' }] }, { checks: green },
    ]);
    expect((await h.execute()).completionReason).toBe('success');
    expect(h.agents()).toHaveLength(0);
    expect(h.commands.filter(command => command.includes('sleep 1'))).toHaveLength(2);
  });

  it('does not mistake an absent Bugbot review for approval', async () => {
    const h = await harness([{ checks: [green[0]!] }]);
    expect((await h.execute()).completionReason).toBe('needs_human');
    expect(h.agents()).toHaveLength(0);
    expect(h.commands.at(-2)).toContain('Timed out');
  });

  it.each([{ changeHead: true }, { mergeState: 'OPEN' }])('parks on unsafe or incomplete merge state: %j', async options => {
    const h = await harness([{ checks: green }], options);
    expect((await h.execute()).completionReason).toBe('needs_human');
  });

  it('fails closed on malformed checks', async () => {
    const h = await harness([{ checks: green }], { malformedChecks: true });
    await expect(h.execute()).rejects.toThrow();
    expect(h.commands.some(command => command.includes('gh pr merge'))).toBe(false);
  });

  it('fails a human handoff if its journal append fails', async () => {
    const h = await harness([{ checks: [] }], { failTerminal: true });
    await expect(executeAuthoredFlow(flow('handoff', async f => f.done('needs_human')), h.client))
      .rejects.toThrow('disk full');
  });

  it('still rejects unawaited effects before recording a human handoff', async () => {
    const h = await harness([{ checks: [] }]);
    await expect(executeAuthoredFlow(flow('handoff-unawaited', async f => {
      f.run('unawaited');
      f.done('needs_human');
    }), h.client)).rejects.toMatchObject({ code: 'unawaited_step' });
    expect(h.specs.some(spec => spec.steps[0]!.id.startsWith('complete-'))).toBe(false);
  });

  it('reports the authored handoff through the direct-run CLI as parked, not successful', async () => {
    const h = await harness([{ checks: [] }]);
    vi.spyOn(runOperations, 'connect').mockResolvedValue(undefined);
    vi.spyOn(JournalClient.prototype, 'runStart').mockImplementation(h.client.runStart.bind(h.client));
    vi.spyOn(JournalClient.prototype, 'journalRead').mockImplementation(h.client.journalRead.bind(h.client));
    const result = await runDirectFlow(join(import.meta.dirname, 'fixtures/needs-human.flow.ts'), '{}', '/unused');
    expect(result).toMatchObject({ exitCode: 3, report: {
      ok: false, status: 'parked', completedSteps: 2,
      diagnostics: [{ severity: 'parked', kind: 'run_parked', message: expect.stringContaining('needs_human') }],
    } });
  });

  it('executes the deterministic commit and force-push steps against a local Git remote, including a no-op repair', async () => {
    const dir = mkdtempSync(join(tmpdir(), "close-git-'space "));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const remote = join(dir, 'remote.git');
    const worktree = join(dir, 'worktree');
    const git = (args: string[], cwd = dir) => {
      const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
      return result.stdout.trim();
    };
    git(['init', '--bare', remote]);
    git(['init', '--initial-branch=feat/slice', worktree]);
    git(['config', 'user.name', 'Close PR Test'], worktree);
    git(['config', 'user.email', 'test@example.invalid'], worktree);
    git(['commit', '--allow-empty', '-m', 'baseline'], worktree);
    git(['remote', 'add', 'origin', remote], worktree);
    git(['push', '-u', 'origin', 'feat/slice'], worktree);
    writeFileSync(join(worktree, 'repaired.ts'), 'export const repaired = true;\n');
    const h = await harness([{ checks: [failed, green[1]!] }, { checks: green }], { input: { worktree } });
    await h.execute();
    const commit = h.commands.find(command => command.includes('git commit -m'))!;
    const push = h.commands.find(command => command.includes('git push --force-with-lease'))!;
    for (const command of [commit, push]) {
      const result = spawnSync('/bin/sh', ['-c', command], { encoding: 'utf8' });
      expect(result.status, result.stderr).toBe(0);
    }
    const head = git(['rev-parse', 'HEAD'], worktree);
    expect(git(['--git-dir', remote, 'rev-parse', 'refs/heads/feat/slice'])).toBe(head);
    expect(git(['log', '-1', '--format=%s'], worktree)).toBe('fix: address PR feedback iteration 1');
    expect(spawnSync('/bin/sh', ['-c', commit]).status).toBe(0);
    expect(git(['rev-parse', 'HEAD'], worktree)).toBe(head);
  });
});

describe('PR state parsing and shell boundaries', () => {
  it.each(['Medium Severity', '**High Severity**', 'Severity: critical', '![P2 Badge](badge.svg)', '<img alt="High Severity" src="badge.svg">'])('blocks Bugbot %s', body => {
    expect(analyzeFindings(green, JSON.stringify([{ ...finding, body }]), JSON.stringify([thread])).findings).toHaveLength(1);
  });
  it('ignores low severity and other providers, but retains unresolved outdated findings', () => {
    const comments = [
      { ...finding, body: 'Low Severity' }, { ...finding, user: { login: 'coderabbitai[bot]' } }, finding,
    ];
    expect(analyzeFindings(green, JSON.stringify(comments), JSON.stringify([{ ...thread, isOutdated: true }])).findings).toHaveLength(1);
  });
  it('does not silently accept broken response shapes', () => {
    expect(() => parseChecks('{}')).toThrow();
    expect(() => parseChecks('[{"name":"ci","bucket":"unknown"}]')).toThrow();
    expect(() => analyzeFindings(green, '{}', '[]')).toThrow();
    expect(() => analyzeFindings(green, '[]', '[{}]')).toThrow();
  });
  it('validates input and PR identity', () => {
    expect(parseInput(JSON.stringify(baseInput))).toEqual(baseInput);
    expect(() => parseInput(JSON.stringify({ ...baseInput, worktree: '.' }))).toThrow();
    expect(() => parseInput(JSON.stringify({ ...baseInput, maxPolls: 0 }))).toThrow();
    expect(parsePrNumber('https://github.com/acme/repo/pull/7\n')).toBe(7);
    expect(() => parsePrNumber('failed: 7')).toThrow();
  });
  it('shell-quotes metacharacters as literal data', () => {
    const data = "a' ; $(echo unsafe) `echo unsafe`\nline";
    expect(spawnSync('/bin/sh', ['-c', `printf '%s' ${quote(data)}`], { encoding: 'utf8' }).stdout).toBe(data);
  });
  it.each([0, 1, 8, 2, 127])('preserves gh output and handles exit status %i', status => {
    const dir = mkdtempSync(join(tmpdir(), 'close-gh-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'gh'), `#!/bin/sh\nprintf '%s' '[]'\nexit ${status}\n`, { mode: 0o755 });
    const result = spawnSync('/bin/sh', ['-c', checksCommand(7, 'acme/repo')], {
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}` }, encoding: 'utf8',
    });
    expect(result.stdout).toBe('[]');
    expect(result.status).toBe([0, 1, 8].includes(status) ? 0 : status);
  });
});
