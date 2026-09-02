import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BUILT_CLI = join(ROOT, 'sdk', 'dist', 'cli.js');
const FLOW = join(ROOT, 'sdk', 'tests', 'fixtures', 'direct-input.flow.ts');
const TOOLCHAIN_TARGET = process.env['CARGO_TARGET_DIR']
  ?? join(process.env['RELAYFLOWS_TOOLCHAIN_HOME'] ?? join(homedir(), '.relayflows-toolchain'), 'target');
const RELAYFLOWD = resolve(process.env['RELAYFLOWD_BIN'] ?? locateRelayflowd());
const temporaryDirectories: string[] = [];
const daemons: ChildProcess[] = [];

beforeAll(() => {
  requireExecutable(RELAYFLOWD, 'relayflowd');
  requireExecutable(BUILT_CLI, 'built flows CLI');
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await stopDaemon(daemon);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('direct .flow.ts input through the built CLI and live runtime', () => {
  it('executes inline and file JSON input through relayflowd', async () => {
    const directory = temporaryDirectory();
    const dataDir = join(directory, 'data');
    await startDaemon(dataDir);

    const inlineOutput = join(directory, 'inline.txt');
    const inline = invokeCli([
      'run', FLOW, '--input', JSON.stringify({ output: inlineOutput, value: 'inline value' }),
      '--data-dir', dataDir,
    ]);
    expect(inline.status, inline.stderr).toBe(0);
    expect(inline.stdout).toContain('completionReason: success');
    expect(readFileSync(inlineOutput, 'utf8')).toBe('inline value');

    const fileOutput = join(directory, 'file.txt');
    const inputPath = join(directory, 'input.json');
    writeFileSync(inputPath, JSON.stringify({ output: fileOutput, value: 'file value' }));
    const file = invokeCli(['run', FLOW, '--input', inputPath, '--data-dir', dataDir]);
    expect(file.status, file.stderr).toBe(0);
    expect(file.stdout).toContain('completionReason: success');
    expect(readFileSync(fileOutput, 'utf8')).toBe('file value');
  });

  it('refuses missing and malformed input before contacting relayflowd', () => {
    const directory = temporaryDirectory();
    const unreachableDataDir = join(directory, 'absent-daemon');

    const missing = invokeCli(['run', FLOW, '--data-dir', unreachableDataDir]);
    expect(missing.status, missing.stderr).toBe(2);
    expect(missing.stderr).toContain('REFUSED [input_missing]');
    expect(missing.stderr).not.toContain('daemon_unreachable');

    const malformed = invokeCli([
      'run', FLOW, '--input', '{"broken":', '--data-dir', unreachableDataDir,
    ]);
    expect(malformed.status, malformed.stderr).toBe(2);
    expect(malformed.stderr).toContain('REFUSED [input_invalid]');
    expect(malformed.stderr).not.toContain('daemon_unreachable');

    const invalidFile = join(directory, 'invalid.json');
    writeFileSync(invalidFile, '{"broken":');
    const invalidFromFile = invokeCli([
      'run', FLOW, '--input', invalidFile, '--data-dir', unreachableDataDir,
    ]);
    expect(invalidFromFile.status, invalidFromFile.stderr).toBe(2);
    expect(invalidFromFile.stderr).toContain('REFUSED [input_invalid]');
    expect(invalidFromFile.stderr).toContain(`Input file "${invalidFile}" is not valid JSON`);

    const missingInputValue = invokeCli(['run', FLOW, '--input', '--json']);
    expect(missingInputValue.status, missingInputValue.stderr).toBe(2);
    expect(missingInputValue.stderr).toContain('REFUSED [invalid_invocation]');
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'flows-direct-input-'));
  temporaryDirectories.push(directory);
  return directory;
}

function invokeCli(args: string[]) {
  return spawnSync(process.execPath, [BUILT_CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
  });
}

async function startDaemon(dataDir: string): Promise<void> {
  const daemon = spawn(RELAYFLOWD, ['--data-dir', dataDir, 'serve'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemons.push(daemon);
  const socket = join(dataDir, 'relayflowd.sock');
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(socket)) return;
    if (daemon.exitCode !== null) throw new Error(`relayflowd exited ${daemon.exitCode}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`relayflowd did not create ${socket}`);
}

async function stopDaemon(daemon: ChildProcess): Promise<void> {
  if (daemon.exitCode !== null) return;
  daemon.kill('SIGTERM');
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      daemon.kill('SIGKILL');
      resolveStop();
    }, 2_000);
    daemon.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}

function locateRelayflowd(): string {
  const direct = join(TOOLCHAIN_TARGET, 'debug', 'relayflowd');
  if (existsSync(direct)) return direct;
  if (existsSync(TOOLCHAIN_TARGET)) {
    const keyed = readdirSync(TOOLCHAIN_TARGET)
      .map((entry) => join(TOOLCHAIN_TARGET, entry, 'debug', 'relayflowd'))
      .filter((candidate) => existsSync(candidate))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (keyed[0] !== undefined) return keyed[0];
  }
  return join(ROOT, 'kernel', 'target', 'debug', 'relayflowd');
}

function requireExecutable(path: string, label: string): void {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(`${label} is not executable at ${path}`);
  }
}
