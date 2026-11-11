import {
  mkdtempSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const SDK = join(ROOT, 'packages', 'sdk');
const BUILT_CLI = join(SDK, 'dist', 'cli.js');
const STANDALONE_BUILDER = join(ROOT, 'scripts', 'build-standalone-cli.mjs');
const SDK_VERSION = (JSON.parse(readFileSync(join(SDK, 'package.json'), 'utf8')) as { version: string }).version;
const PREFLIGHT = join(ROOT, 'testdata', 'preflight');
const temporaryDirectories: string[] = [];

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

/** Preserve npm's actual nested dependency layout without workspace links. */
function copySurfaceInstallation(directory: string): void {
  const modules = realpathSync(join(SDK, 'node_modules'));
  const copied = new Set<string>();
  const copy = (installed: string): void => {
    const source = realpathSync(installed);
    if (copied.has(source)) return;
    const location = relative(modules, source);
    expect(location.startsWith(`..${sep}`) || location === '..').toBe(false);
    copied.add(source);
    const destination = join(directory, 'node_modules', location);
    mkdirSync(dirname(destination), { recursive: true });
    cpSync(source, destination, { recursive: true, dereference: true,
      filter: path => path !== join(source, 'node_modules') });
    const manifest = JSON.parse(readFileSync(join(source, 'package.json'), 'utf8'));
    for (const name of Object.keys({ ...manifest.dependencies, ...manifest.peerDependencies })) {
      let parent = source;
      for (;;) {
        const candidate = join(parent, 'node_modules', name);
        if (existsSync(join(candidate, 'package.json'))) { copy(candidate); break; }
        const next = dirname(parent);
        if (next === parent) {
          expect(manifest.peerDependenciesMeta?.[name]?.optional, `missing installed dependency ${name}`).toBe(true);
          break;
        }
        parent = next;
      }
    }
  };
  copy(join(modules, '@relayflows/surface'));
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
  it('loads authored bare package imports in the standalone without enabling dotenv or bunfig', () => {
    const directory = temporaryDirectory();
    const standalone = join(directory, 'flows');
    const built = spawnSync(process.execPath, [STANDALONE_BUILDER,
      process.platform === 'darwin' ? 'bun-darwin-arm64' : 'bun-linux-x64', standalone], {
      cwd: ROOT, encoding: 'utf8', timeout: 120_000,
      env: { ...process.env, FLOWS_BUILD_BUN: process.env['FLOWS_BUILD_BUN'] ?? 'bun' },
    });
    expect(built.status, built.stderr + built.stdout).toBe(0);
    copySurfaceInstallation(directory);
    writeFileSync(join(directory, 'package.json'), '{"private":true,"type":"module"}');
    writeFileSync(join(directory, '.env'), 'FLOWS_STANDALONE_DOTENV_PROBE=unexpected\n');
    writeFileSync(join(directory, 'bunfig.toml'), 'preload = ["./must-not-preload.mjs"]\n');
    writeFileSync(join(directory, 'must-not-preload.mjs'), "throw new Error('bunfig unexpectedly loaded');\n");
    const flow = join(directory, 'physical-surface.flow.ts');
    writeFileSync(flow, `import { flow } from '@relayflows/surface';
import { writeFileSync } from 'node:fs';
if (process.env.FLOWS_STANDALONE_DOTENV_PROBE !== undefined) throw new Error('dotenv unexpectedly loaded');
export default flow('physical-surface', async f => {
  writeFileSync(${JSON.stringify(join(directory, 'body-executed'))}, 'unexpected');
  f.done('success');
});\n`);
    const checked = spawnSync(standalone, ['check', '--json', '--no-daemon-check', flow], {
      cwd: directory, encoding: 'utf8', timeout: 30_000,
      // No NODE_PATH/NODE_OPTIONS or workspace package-resolution fallback.
      env: { PATH: process.env.PATH, HOME: directory },
    });
    expect(checked.status, checked.stderr + checked.stdout).toBe(0);
    expect(JSON.parse(checked.stdout)).toMatchObject({ ok: true, path: flow });
    expect(existsSync(join(directory, 'body-executed'))).toBe(false);
  }, 150_000);

  it('build produces an executable CLI artifact', () => {
    expect(statSync(BUILT_CLI).mode & 0o111).not.toBe(0);
  });

  it.each(['--version', '-V'])('prints the installed SDK version for %s', (flag) => {
    const result = spawnSync(process.execPath, [BUILT_CLI, flag], {
      cwd: ROOT,
      encoding: 'utf8',
      env: process.env,
    });

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${SDK_VERSION}\n`);
    expect(result.stderr).toBe('');
  });

  it('keeps version flags strict when extra arguments are supplied', () => {
    const result = spawnSync(process.execPath, [BUILT_CLI, '--version', 'extra'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: process.env,
    });

    expect(result.error).toBeUndefined();
    expect(result.status).toBe(2);
    expect(result.stdout).toBe('');
    expect(result.stderr).toContain('REFUSED [invalid_invocation]');
  });

  it.each(['--version', '-V'])('prints the installed SDK version from the standalone binary for %s', (flag) => {
    const directory = temporaryDirectory();
    const standalone = join(directory, 'flows');
    const built = spawnSync(process.execPath, [STANDALONE_BUILDER,
      process.platform === 'darwin' ? 'bun-darwin-arm64' : 'bun-linux-x64', standalone], {
      cwd: ROOT,
      encoding: 'utf8',
      timeout: 120_000,
      env: { ...process.env, FLOWS_BUILD_BUN: process.env['FLOWS_BUILD_BUN'] ?? 'bun' },
    });
    expect(built.error).toBeUndefined();
    expect(built.status, built.stderr + built.stdout).toBe(0);

    const result = spawnSync(standalone, [flag], { cwd: ROOT, encoding: 'utf8', env: process.env });
    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${SDK_VERSION}\n`);
    expect(result.stderr).toBe('');
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
