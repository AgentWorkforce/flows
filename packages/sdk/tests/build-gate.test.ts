import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(sdk, '../..');
const cli = join(sdk, 'dist/cli.js');
const key = Buffer.alloc(32, 7).toString('base64');
const temporary: string[] = [];

async function temp(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), 'flows-build-gate-test-'));
  temporary.push(path);
  return path;
}

function invoke(args: string[], cwd = repo, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, 'build', ...args], {
    cwd, encoding: 'utf8', timeout: 120_000,
    env: { PATH: process.env['PATH'], FLOWS_BUILD_KEY: key, ...env },
  });
}

afterEach(async () => {
  await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true })));
});

describe('flows build gates on flows check green (#318)', () => {
  it('refuses a flow with an unresolvable named-agent CLI and leaves no artifacts', async () => {
    const cwd = await temp();
    await writeFile(join(cwd, 'bad.yaml'), JSON.stringify({
      version: '0.1.0', name: 'unbuildable',
      steps: [{ id: 'ask', type: 'agent', instruction: 'hello' }],
    }));
    const out = join(cwd, 'dist/flows');
    const result = invoke(['--out', out, 'bad.yaml'], cwd);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('cli_unresolved');
    // No `dist/flows/<name>@sha256:<hex>/` — the refusal path never leaves
    // partial artifacts.
    expect(existsSync(out)).toBe(false);
  });

  it('--json emits one CheckReport object on stdout on refusal, exits 2, no artifacts', async () => {
    const cwd = await temp();
    await writeFile(join(cwd, 'bad.yaml'), JSON.stringify({
      version: '0.1.0', name: 'unbuildable-json',
      steps: [{ id: 'ask', type: 'agent', instruction: 'hello' }],
    }));
    const out = join(cwd, 'dist/flows');
    const result = invoke(['--json', '--out', out, 'bad.yaml'], cwd);
    expect(result.status).toBe(2);
    // Exactly one JSON object on stdout — same shape `flows check --json` emits.
    const trimmed = result.stdout.trim();
    expect(() => JSON.parse(trimmed)).not.toThrow();
    const report = JSON.parse(trimmed) as {
      ok: boolean;
      diagnostics: Array<{ severity: string; kind: string }>;
      gates: unknown[];
      resolutions: unknown[];
    };
    expect(report.ok).toBe(false);
    expect(Array.isArray(report.diagnostics)).toBe(true);
    expect(report.diagnostics.some(d => d.severity === 'refusal' && d.kind === 'cli_unresolved')).toBe(true);
    expect(Array.isArray(report.gates)).toBe(true);
    expect(Array.isArray(report.resolutions)).toBe(true);
    expect(existsSync(out)).toBe(false);
  });

  it('builds the bundle on success (regression: gate must not block valid flows)', async () => {
    const cwd = await temp();
    // Deterministic-only YAML flow — no agent, no CLI required. Uses the
    // same shape as the fixture at testdata/hello-deterministic.flow.yaml
    // but keeps this test self-contained.
    await writeFile(join(cwd, 'script.sh'), '#!/bin/sh\necho hello\n');
    await writeFile(join(cwd, 'good.yaml'), JSON.stringify({
      version: '0.1.0', name: 'buildable',
      steps: [{ id: 'run', type: 'deterministic', command: './script.sh' }],
    }));
    const out = join(cwd, 'out');
    const result = invoke(['--out', out, 'good.yaml'], cwd);
    expect(result.status).toBe(0);
    const bundle = result.stdout.trim();
    expect(bundle).toContain('buildable@sha256:');
    const files = await readdir(bundle);
    // Full bundle emitted: canonical spec, preflight, manifest, identity.
    expect(files).toContain('spec.canonical.json');
    expect(files).toContain('preflight.json');
    expect(files).toContain('manifest.json');
    expect(files).toContain('identity.json');
    // Bundle name shape matches the digest-addressing convention.
    expect(basename(bundle).startsWith('buildable@sha256:')).toBe(true);
    // Sanity: assets captured from build-time file references.
    expect(await readFile(join(bundle, 'assets/script.sh'), 'utf8')).toContain('echo hello');
  });
});
