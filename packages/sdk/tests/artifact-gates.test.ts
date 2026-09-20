import { EventEmitter } from 'node:events';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// A fake `claude` whose "work" is whatever the test's `onSpawn` hook writes
// into the cwd it was spawned in, so artifact detection is exercised without
// a real CLI.
let onSpawn: ((cwd: string | undefined) => void) | undefined;
vi.mock('node:child_process', async () => {
  const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
  return {
    ...actual,
    spawn: (cli: string, _args: string[], options: Record<string, unknown>) => {
      const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
      const stdin = new EventEmitter() as EventEmitter & Record<string, unknown>;
      stdin.end = () => {};
      stdin.write = (_: unknown, cb: (e?: Error) => void) => { cb(); return true; };
      stdin.destroyed = false;
      stdin.writableEnded = false;
      const stdout = new EventEmitter();
      child.stdin = stdin; child.stdout = stdout; child.stderr = new EventEmitter();
      child.kill = () => true;
      setImmediate(() => {
        onSpawn?.(options['cwd'] as string | undefined);
        stdout.emit('data', Buffer.from(cli === 'claude'
          ? JSON.stringify({ type: 'result', result: 'done', usage: { input_tokens: 1, output_tokens: 1 }, total_cost_usd: 0 })
          : JSON.stringify({ type: 'usage', usage: { input_tokens: 1, output_tokens: 1, total_cost_usd: 0 } })));
        child.emit('close', 0);
      });
      return child as unknown as ReturnType<typeof actual.spawn>;
    },
  };
});

import { runAgentCli } from '../src/worker-cli.js';
import { compileSpec } from '../src/compile.js';
import { lowerNamedGates } from '../src/named-gate-lowering.js';
import { namedGateErrors, namedGateFailure } from '../src/named-gates.js';
import { validateSpec } from '../src/validate.js';
import { checkFlow } from '../src/cli/check.js';
import { preflight } from '../src/preflight.js';
import { unscannedArtifactPrefix } from '../src/artifact-scan-policy.js';
import { snapshotWorkspaceFiles } from '../src/agent-artifacts.js';
import { execFileSync } from 'node:child_process';

const dirs: string[] = [];
afterEach(() => { onSpawn = undefined; for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
function tempDir(): string { const d = mkdtempSync(join(tmpdir(), 'artifact-gates-')); dirs.push(d); return d; }

describe('worker-side artifacts', () => {
  it('journals the files the CLI created or changed in its cwd, content-hashed, dotdirs and node_modules excluded', async () => {
    const cwd = tempDir();
    mkdirSync(join(cwd, 'review'));
    writeFileSync(join(cwd, 'review/existing.md'), 'v1');
    writeFileSync(join(cwd, 'untouched.txt'), 'same');
    onSpawn = (dir) => {
      mkdirSync(join(dir!, 'review'), { recursive: true });
      writeFileSync(join(dir!, 'review/security.md'), 'findings');
      writeFileSync(join(dir!, 'review/existing.md'), 'v2');
      mkdirSync(join(dir!, '.cache'), { recursive: true });
      writeFileSync(join(dir!, '.cache/tmp'), 'x');
      mkdirSync(join(dir!, 'node_modules/dep'), { recursive: true });
      writeFileSync(join(dir!, 'node_modules/dep/index.js'), 'x');
    };
    const result = await runAgentCli('claude', 'review', undefined, 'claude-opus-5', undefined, undefined, 'agent', undefined, cwd);
    expect(result.exit_code, result.stderr_tail).toBe(0);
    expect(result.artifacts).toEqual(['review/existing.md', 'review/security.md']);
  });

  it('reports an empty list when nothing changed, and none at all for llm mode', async () => {
    const cwd = tempDir();
    writeFileSync(join(cwd, 'a.txt'), 'a');
    const agent = await runAgentCli('claude', 'noop', undefined, 'claude-opus-5', undefined, undefined, 'agent', undefined, cwd);
    expect(agent.artifacts).toEqual([]);
    const llm = await runAgentCli('claude', 'answer', undefined, 'claude-opus-5', undefined, undefined, 'llm', undefined, cwd);
    expect(llm.artifacts).toBeUndefined();
  });
});

describe('worker-side artifacts: concurrency', () => {
  it('serializes overlapping executions in one cwd so writes are attributed to the agent that made them', async () => {
    const cwd = tempDir();
    let calls = 0;
    onSpawn = (dir) => {
      calls += 1;
      // Only the first execution writes; the second must not see that file
      // as its own artifact even though both were started together.
      if (calls === 1) writeFileSync(join(dir!, 'first.md'), 'first');
    };
    const [a, b] = await Promise.all([
      runAgentCli('claude', 'one', undefined, 'claude-opus-5', undefined, undefined, 'agent', undefined, cwd),
      runAgentCli('claude', 'two', undefined, 'claude-opus-5', undefined, undefined, 'agent', undefined, cwd),
    ]);
    expect(a.artifacts).toEqual(['first.md']);
    expect(b.artifacts).toEqual([]);
  });
});

describe('artifact_exists named gate', () => {
  it('validates a relative POSIX path and refuses escapes, absolute paths and NUL', () => {
    expect(namedGateErrors({ type: 'artifact_exists', path: 'review/security.md' }, undefined, 'g')).toEqual([]);
    for (const path of ['', '  ', '/etc/passwd', '../x', 'a/../b', './x', 'a//b', 'a\0b', 42]) {
      const errors = namedGateErrors({ type: 'artifact_exists', path }, undefined, 'g');
      expect(errors, String(path)).toHaveLength(1);
      expect(namedGateFailure(errors)).toBe('gate_path_invalid');
    }
    const rejected = validateSpec({ version: '0.1.0', name: 'x', steps: [{ id: 'a', type: 'agent', instruction: 'i', cli: 'c',
      verification: { type: 'artifact_exists', path: '../x' } }] });
    expect(rejected.ok).toBe(false);
    expect(JSON.stringify(rejected)).toContain('gate_path_invalid');
    expect(JSON.stringify(validateSpec({ version: '0.1.0', name: 'x', steps: [{ id: 'a', type: 'agent', instruction: 'i', cli: 'c',
      verification: { type: 'nope' } }] }))).toContain('artifact_exists');
  });

  it('lowers to a deterministic gate step that reads the journaled artifacts, never the disk', () => {
    const spec = compileSpec({ version: '0.1.0', name: 'x', steps: [
      { id: 'review', type: 'agent', instruction: 'i', cli: 'c', verification: { type: 'artifact_exists', path: 'review/security.md' } },
      { id: 'after', type: 'deterministic', command: 'true', dependsOn: ['review'] },
    ] });
    const lowered = lowerNamedGates(spec.steps);
    expect(lowered.map(s => s.id)).toEqual(['review', 'review.gate', 'after']);
    const gate = lowered[1]!;
    expect(gate.type).toBe('deterministic');
    expect(gate.dependsOn).toEqual(['review']);
    expect(gate.input).toEqual({ output: { step: 'review' } });
    expect(gate.verification).toEqual({ type: 'exit_code' });
    expect(lowered[2]!.dependsOn).toEqual(['review', 'review.gate']);
    // The gate command judges FLOWS_INPUT only: present → 0, absent → 1.
    const command = (gate as { command: string }).command;
    expect(command).not.toContain('readdir');
    expect(command).not.toContain('existsSync');
    const run = (output: unknown) => execFileSync('sh', ['-c', command], {
      env: { ...process.env, FLOWS_INPUT: JSON.stringify({ output }) }, stdio: 'pipe',
    });
    expect(() => run({ exit_code: 0, stdout_tail: '', artifacts: ['review/security.md'] })).not.toThrow();
    expect(() => run({ exit_code: 0, stdout_tail: '', artifacts: ['other.md'] })).toThrow();
    expect(() => run({ exit_code: 0, stdout_tail: '' })).toThrow();
    expect(() => run({ message: 'a JSON-speaking agent owns its output' })).toThrow();
  });

  it('is preflightable: flows check prints it as a kernel exit_code gate', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'flows.json'), JSON.stringify({ cli: 'true' }));
    writeFileSync(join(dir, 'flow.yaml'), JSON.stringify({ version: '0.1.0', name: 'gated', steps: [
      { id: 'review', type: 'agent', instruction: 'i', cli: 'true', verification: { type: 'artifact_exists', path: 'review/security.md' } },
    ] }));
    const report = checkFlow(join(dir, 'flow.yaml')).report;
    expect(report.gates).toContainEqual(expect.objectContaining({ stepId: 'review', checks: ['exit_code'], preflightable: true, replayable: true }));
  });
});

/**
 * #513: the gate reads the worker's journaled `artifacts` list, and the
 * bundled worker's scan never puts a dot-named or `node_modules` path in it.
 * That makes such a gate statically unsatisfiable, which preflight now refuses
 * rather than letting a run discover it. Retire this block with the module.
 */
describe('artifact_exists named gate: static reachability', () => {
  const probes = () => ({ cli: () => ({ exists: true, authenticated: true }), executor: () => true, command: () => true });
  const gated = (path: string) => ({
    version: '0.1.0', name: 'x',
    steps: [{ id: 'review', type: 'agent' as const, instruction: 'i', cli: 'x',
      verification: { type: 'artifact_exists' as const, path } }],
  });

  it.each([
    ['.workflow-artifacts/rust/review.md', '.workflow-artifacts'],
    ['.hidden.md', '.hidden.md'],
    ['node_modules/pkg/out.md', 'node_modules'],
    ['reports/.drafts/review.md', 'reports/.drafts'],
    ['reports/node_modules/out.md', 'reports/node_modules'],
    // The whole prefix, not the offending segment alone: that prefix is the
    // directory the author has to move the artifact out of.
    ['a/b/.c/d/e.md', 'a/b/.c'],
  ])('refuses %s and names the excluded prefix %s', (path, prefix) => {
    const result = preflight(gated(path) as never, { probes: probes() });
    expect(result.ok).toBe(false);
    const refusal = result.diagnostics.find(d => d.kind === 'gate_path_unreachable');
    expect(refusal, JSON.stringify(result.diagnostics)).toMatchObject({ severity: 'refusal', stepId: 'review' });
    expect(refusal!.message).toContain(`"${prefix}"`);
    expect(refusal!.message).toContain(path);
  });

  it.each([
    'review/security.md',
    // Exact segment comparison, so a similar name is not an exclusion.
    'node_modules-copy/out.md',
    'reports/node_modules.md',
    // A dot inside a segment is not a dot-named entry.
    'review.md',
    'reports/v1.2/review.md',
    // A backslash is an ordinary filename character in a POSIX path, never a
    // separator: `readdir` reports one entry whose name starts with "d".
    String.raw`dir\.hidden.md`,
  ])('accepts %s, which the scan does record', (path) => {
    const result = preflight(gated(path) as never, { probes: probes() });
    expect(result.diagnostics.filter(d => d.kind === 'gate_path_unreachable')).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it('agrees with what the real scan records, for every case above', async () => {
    const cwd = tempDir();
    const paths = [
      '.workflow-artifacts/rust/review.md', '.hidden.md', 'node_modules/pkg/out.md',
      'reports/.drafts/review.md', 'reports/node_modules/out.md', 'a/b/.c/d/e.md',
      'review/security.md', 'node_modules-copy/out.md', 'reports/node_modules.md',
      'review.md', 'reports/v1.2/review.md', String.raw`dir\.hidden.md`,
    ];
    for (const path of paths) {
      const full = join(cwd, ...path.split('/'));
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, 'x');
    }
    const scanned = new Set((await snapshotWorkspaceFiles(cwd)).keys());
    // The predicate is the scan's rule, so "excluded by the predicate" and
    // "absent from the scan" must be the same set. A drift in either
    // direction would make the refusal lie.
    for (const path of paths) {
      expect(scanned.has(path), path).toBe(unscannedArtifactPrefix(path) === undefined);
    }
  });

  it('is reported even when an unrelated environment refusal returns first', () => {
    // `cli_unresolved` returns from preflight before any probe runs. The
    // author fixes the CLI, reruns, and would otherwise meet the dead gate
    // only on the pass after that — or at run time.
    const result = preflight({
      version: '0.1.0', name: 'x',
      steps: [{ id: 'review', type: 'agent', instruction: 'i',
        verification: { type: 'artifact_exists', path: '.out/review.md' } }],
    } as never, { probes: probes() });

    expect(result.diagnostics.map(d => d.kind)).toEqual(['gate_path_unreachable', 'cli_unresolved']);
  });

  it('refuses through flows check, naming the step and the prefix', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'flows.json'), JSON.stringify({ cli: 'true' }));
    writeFileSync(join(dir, 'flow.yaml'), JSON.stringify({ version: '0.1.0', name: 'gated', steps: [
      { id: 'review', type: 'agent', instruction: 'i', cli: 'true',
        verification: { type: 'artifact_exists', path: '.workflow-artifacts/rust/review.md' } },
    ] }));

    const report = checkFlow(join(dir, 'flow.yaml')).report;

    expect(report.ok).toBe(false);
    expect(report.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'refusal', kind: 'gate_path_unreachable', stepId: 'review',
    }));
  });
});
