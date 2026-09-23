#!/usr/bin/env node

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';

class EnvironmentError extends Error {}

export async function runBlackBoxCrash(options = {}) {
  if (process.platform === 'win32') {
    throw new EnvironmentError('SIGKILL process semantics are required');
  }
  const repoRoot = resolve(options.repoRoot ?? fileURLToPath(new URL('../..', import.meta.url)));
  const binary = options.binary ?? resolveRelayflowd(repoRoot);
  const fixture = mkdtempSync(join(tmpdir(), 'relayflows-black-box-'));
  const dataDir = join(fixture, 'data');
  const effects = join(fixture, 'effects.txt');
  const specPath = join(fixture, 'flow.json');
  const assertions = [];

  try {
    writeFileSync(specPath, `${JSON.stringify(flowSpec(effects), null, 2)}\n`);
    const child = spawn(
      binary,
      [
        '--data-dir',
        dataDir,
        'run',
        specPath,
        '--pause-before-step',
        'second',
      ],
      { detached: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    let stdout = '';
    let stderr = '';
    let spawnError = null;
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => {
      spawnError = error;
      stderr += String(error);
    });

    await waitUntil('first effect and durable run receipt', () => {
      if (spawnError) throw new EnvironmentError(spawnError.message);
      if (child.exitCode !== null) {
        throw new Error(`relayflowd exited before the kill boundary: ${stdout}${stderr}`);
      }
      return readEffects(effects).join(',') === 'first' && runIds(dataDir).length === 1;
    });
    check(assertions, readEffects(effects), ['first'], 'only step one completed before SIGKILL');
    const ids = runIds(dataDir);
    check(assertions, ids.length, 1, 'one opaque run receipt exists');

    const exited = once(child, 'exit');
    process.kill(-child.pid, 'SIGKILL');
    const [exitCode, signal] = await exited;
    check(assertions, exitCode, null, 'killed process has no numeric exit code');
    check(assertions, signal, 'SIGKILL', 'workflow process observed SIGKILL');

    const resumed = spawnSync(binary, ['--data-dir', dataDir, 'resume', ids[0]], {
      encoding: 'utf8',
      timeout: 30000,
    });
    if (resumed.error) throw new EnvironmentError(resumed.error.message);
    check(assertions, resumed.status, 0, `resume exited zero: ${resumed.stderr}`);
    const outcome = JSON.parse(resumed.stdout);
    check(assertions, outcome.status, 'completed', 'resume completed the run');
    check(assertions, outcome.completion_reason, 'success', 'completion reason is declared success');
    check(assertions, outcome.completed_steps, 3, 'all three steps completed');
    check(
      assertions,
      readEffects(effects),
      ['first', 'second', 'third'],
      'every external effect occurred exactly once and in dependency order',
    );

    return {
      assertions: assertions.length,
      runStatus: outcome.status,
      completionReason: outcome.completion_reason,
      effects: readEffects(effects),
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

function resolveRelayflowd(repoRoot) {
  const kernel = join(repoRoot, 'kernel');
  const cargo = join(repoRoot, 'ops', 'cargo.sh');
  runEnvironmentCommand(cargo, ['build', '-p', 'relayflowd'], kernel);
  const metadata = runEnvironmentCommand(
    cargo,
    ['metadata', '--format-version', '1', '--no-deps'],
    kernel,
  );
  const targetDirectory = JSON.parse(metadata.stdout).target_directory;
  return join(targetDirectory, 'debug', 'relayflowd');
}

function runEnvironmentCommand(file, args, cwd) {
  const result = spawnSync(file, args, { cwd, encoding: 'utf8', timeout: 120000 });
  if (result.error || result.status !== 0) {
    throw new EnvironmentError(
      `${file} ${args.join(' ')} failed: ${result.error?.message ?? result.stderr ?? result.stdout}`,
    );
  }
  return result;
}

function flowSpec(effects) {
  const append = "require('node:fs').appendFileSync(process.argv[1], process.argv[2])";
  const step = (id, value, dependsOn) => ({
    id,
    type: 'deterministic',
    ...(dependsOn ? { depends_on: [dependsOn] } : {}),
    command: [process.execPath, '-e', append, effects, `${value}\n`],
  });
  return {
    name: 'black-box-crash-resume',
    steps: [step('first', 'first'), step('second', 'second', 'first'), step('third', 'third', 'second')],
  };
}

function runIds(dataDir) {
  try {
    return readdirSync(join(dataDir, 'runs'))
      .filter((name) => name.endsWith('.sqlite3'))
      .map((name) => name.slice(0, -'.sqlite3'.length));
  } catch {
    return [];
  }
}

function readEffects(path) {
  try {
    return readFileSync(path, 'utf8').trimEnd().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

async function waitUntil(description, predicate) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  }
  throw new Error(`timed out waiting for ${description}`);
}

function check(assertions, actual, expected, description) {
  assert.deepEqual(actual, expected, description);
  assertions.push(description);
}

async function main() {
  try {
    const result = await runBlackBoxCrash();
    process.stdout.write(`BLACK_BOX_ASSERTIONS: ${result.assertions}/${result.assertions}\n`);
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } catch (error) {
    const environment = error instanceof EnvironmentError;
    process.stderr.write(
      `${environment ? 'BENCHMARK_ENVIRONMENT_FAILURE' : 'BLACK_BOX_ASSERTION_FAILURE'}: ${error.stack ?? error}\n`,
    );
    process.exitCode = environment ? 2 : 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) await main();
