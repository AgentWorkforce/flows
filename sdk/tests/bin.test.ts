import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SDK = join(ROOT, 'sdk');
const BUILT_CLI = join(SDK, 'dist', 'cli.js');
const PREFLIGHT = join(ROOT, 'testdata', 'preflight');
const temporaryDirectories: string[] = [];

beforeAll(() => {
  // These tests exercise the published artifact, so they build it themselves
  // instead of relying on a developer to have run the DoD build beforehand.
  const build = spawnSync('npm', ['run', 'build'], {
    cwd: SDK,
    encoding: 'utf8',
  });
  expect(build.status, build.stderr || build.stdout).toBe(0);
});

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'flows-bin-'));
  temporaryDirectories.push(directory);
  return directory;
}

function invoke(entry: string, flow: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(entry, ['check', flow], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
  });
}

function invokeWithNode(flow: string, env: NodeJS.ProcessEnv = process.env) {
  return spawnSync(process.execPath, [BUILT_CLI, 'check', flow], {
    cwd: ROOT,
    encoding: 'utf8',
    env,
  });
}

function expectMissingCliRefusal(result: ReturnType<typeof invoke>): void {
  expect(result.error).toBeUndefined();
  expect(result.status, result.stderr).toBe(2);
  expect(result.stderr).toContain('REFUSED [cli_missing]');
}

describe('built flows binary', () => {
  it('build produces an executable CLI artifact', () => {
    expect(statSync(BUILT_CLI).mode & 0o111).not.toBe(0);
  });

  it('refuses through a symlink to the built artifact', () => {
    const entry = join(temporaryDirectory(), 'flows');
    symlinkSync(BUILT_CLI, entry);

    expectMissingCliRefusal(invoke(entry, join(PREFLIGHT, 'cli-missing.flow.yaml')));
  });

  it('refuses through a symlinked directory component', () => {
    const linkedDist = join(temporaryDirectory(), 'linked-dist');
    symlinkSync(dirname(BUILT_CLI), linkedDist, 'dir');

    expectMissingCliRefusal(invoke(join(linkedDist, 'cli.js'), join(PREFLIGHT, 'cli-missing.flow.yaml')));
  });

  it('classifies a signal-terminated auth probe as probe_failed', () => {
    const result = invokeWithNode(join(PREFLIGHT, 'cli-signal.flow.yaml'));

    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('REFUSED [probe_failed]');
    expect(result.stderr).toContain('terminated by signal "SIGSEGV"');
    expect(result.stderr).not.toContain('cli_unauthenticated');
  });

  it('classifies an unavailable PATH resolver as probe_failed', () => {
    const result = invokeWithNode(join(PREFLIGHT, 'empty-path.flow.yaml'), {
      ...process.env,
      PATH: '',
    });

    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('REFUSED [probe_failed]');
    expect(result.stderr).toContain('probe process could not be started');
    expect(result.stderr).not.toContain('cli_missing');
  });

  it('does not describe a present non-executable CLI as missing', () => {
    const directory = temporaryDirectory();
    const cli = join(directory, 'not-executable');
    const flow = join(directory, 'not-executable.flow.yaml');
    writeFileSync(join(directory, 'flows.json'), JSON.stringify({ executors: [] }));
    writeFileSync(cli, '#!/bin/sh\nexit 0\n', { mode: 0o644 });
    writeFileSync(flow, [
      "version: '0.1.0'",
      'steps:',
      '  - id: answer',
      '    type: llm',
      '    cli: ./not-executable',
      '    prompt: answer',
      '',
    ].join('\n'));

    const result = invokeWithNode(flow);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('REFUSED [cli_missing]');
    expect(result.stderr).toContain('does not resolve as an executable');
    expect(result.stderr).not.toContain('but it is missing');
  });

  it('runs one auth probe for three steps sharing a flow CLI', () => {
    const probeLog = join(temporaryDirectory(), 'probe.log');
    writeFileSync(probeLog, '');
    const result = invokeWithNode(join(PREFLIGHT, 'shared-cli.flow.yaml'), {
      ...process.env,
      PREFLIGHT_PROBE_LOG: probeLog,
    });

    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain('CHECK PASSED');
    expect(readFileSync(probeLog, 'utf8')).toBe('auth status\n');
  });
});
