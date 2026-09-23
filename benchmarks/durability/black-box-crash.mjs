#!/usr/bin/env node

import assert from 'node:assert/strict';
import { once } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const EXPECTED_ASSERTIONS = 16;

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
  const attempts = join(fixture, 'attempts.txt');
  const gate = join(fixture, 'gate');
  const stepPid = join(fixture, 'step.pid');
  const specPath = join(fixture, 'flow.json');
  const assertions = [];

  try {
    writeFileSync(
      specPath,
      `${JSON.stringify(flowSpec({ effects, attempts, gate, stepPid }), null, 2)}\n`,
    );
    const initial = spawnSync(
      binary,
      ['--data-dir', dataDir, 'run', specPath, '--stop-after', '1'],
      { encoding: 'utf8', timeout: 30000 },
    );
    if (initial.error) throw new EnvironmentError(initial.error.message);
    check(assertions, initial.status, 0, `initial run exited zero: ${initial.stderr}`);
    const receipt = parseOutcome(initial.stdout);
    check(assertions, receipt.status, 'interrupted', 'public run receipt reports interruption');
    check(
      assertions,
      receipt.completion_reason,
      null,
      'interrupted receipt has no completion reason',
    );
    check(assertions, receipt.completed_steps, 1, 'public run receipt reports one completed step');
    check(
      assertions,
      typeof receipt.run_id === 'string' && receipt.run_id.length > 0,
      true,
      'public run receipt includes a run id',
    );
    check(assertions, readLines(effects), ['first'], 'only step one completed before resume');

    const child = spawn(
      binary,
      ['--data-dir', dataDir, 'resume', receipt.run_id],
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

    await waitUntil('the resumed second step to be in flight', () => {
      if (spawnError) throw new EnvironmentError(spawnError.message);
      if (child.exitCode !== null) {
        throw new Error(`relayflowd exited before the kill boundary: ${stdout}${stderr}`);
      }
      return readLines(attempts).join(',') === 'attempt' && readPid(stepPid) !== null;
    });
    check(assertions, readLines(attempts), ['attempt'], 'step two was in flight before SIGKILL');

    const exited = once(child, 'exit');
    process.kill(-child.pid, 'SIGKILL');
    const [exitCode, signal] = await exited;
    check(assertions, exitCode, null, 'killed resume process has no numeric exit code');
    check(assertions, signal, 'SIGKILL', 'resume process observed SIGKILL');
    await killAndWait(readPid(stepPid));
    check(assertions, isProcessAlive(readPid(stepPid)), false, 'in-flight step process was killed');
    writeFileSync(gate, 'open\n');

    const resumed = spawnSync(binary, ['--data-dir', dataDir, 'resume', receipt.run_id], {
      encoding: 'utf8',
      timeout: 30000,
    });
    if (resumed.error) throw new EnvironmentError(resumed.error.message);
    check(assertions, resumed.status, 0, `final resume exited zero: ${resumed.stderr}`);
    const outcome = parseOutcome(resumed.stdout);
    check(assertions, outcome.status, 'completed', 'final resume completed the run');
    check(
      assertions,
      outcome.completion_reason,
      'success',
      'completion reason is declared success',
    );
    check(assertions, outcome.completed_steps, 3, 'all three steps completed');
    check(
      assertions,
      readLines(attempts),
      ['attempt', 'attempt'],
      'the interrupted unfinished step executed a replacement attempt',
    );
    check(
      assertions,
      readLines(effects),
      ['first', 'second', 'third'],
      'the completed step was not replayed and final effects occurred once in dependency order',
    );
    assert.equal(assertions.length, EXPECTED_ASSERTIONS, 'harness assertion count changed');

    return {
      assertionsPassed: assertions.length,
      assertionsExpected: EXPECTED_ASSERTIONS,
      assertionNames: assertions,
      runStatus: outcome.status,
      completionReason: outcome.completion_reason,
      attempts: readLines(attempts).length,
      effects: readLines(effects),
    };
  } finally {
    rmSync(fixture, { recursive: true, force: true });
  }
}

export function parseOutcome(stdout) {
  const lines = String(stdout).split('\n').map((line) => line.trim()).filter(Boolean).reverse();
  for (const line of lines) {
    try {
      const outcome = JSON.parse(line);
      if (outcome && typeof outcome === 'object' && typeof outcome.run_id === 'string') {
        return outcome;
      }
    } catch {
      // Non-JSON CLI diagnostics are allowed; the last valid receipt is authoritative.
    }
  }
  throw new Error(`relayflowd stdout did not contain a JSON run receipt: ${stdout}`);
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

function flowSpec({ effects, attempts, gate, stepPid }) {
  const append = "require('node:fs').appendFileSync(process.argv[1], process.argv[2])";
  const step = (id, value, dependsOn) => ({
    id,
    type: 'deterministic',
    ...(dependsOn ? { depends_on: [dependsOn] } : {}),
    command: [process.execPath, '-e', append, effects, `${value}\n`],
  });
  const blockingSecond = [
    process.execPath,
    '-e',
    [
      "const fs=require('node:fs')",
      "fs.appendFileSync(process.argv[3], 'attempt\\n')",
      'fs.writeFileSync(process.argv[4], String(process.pid))',
      'const wait=new Int32Array(new SharedArrayBuffer(4))',
      'while(!fs.existsSync(process.argv[2])) Atomics.wait(wait,0,0,20)',
      "fs.appendFileSync(process.argv[1], 'second\\n')",
    ].join(';'),
    effects,
    gate,
    attempts,
    stepPid,
  ];
  return {
    name: 'black-box-crash-resume',
    steps: [
      step('first', 'first'),
      { id: 'second', type: 'deterministic', depends_on: ['first'], command: blockingSecond },
      step('third', 'third', 'second'),
    ],
  };
}

function readLines(path) {
  try {
    return readFileSync(path, 'utf8').trimEnd().split('\n').filter(Boolean);
  } catch {
    return [];
  }
}

function readPid(path) {
  try {
    const pid = Number(readFileSync(path, 'utf8'));
    return Number.isInteger(pid) && pid > 0 ? pid : null;
  } catch {
    return null;
  }
}

async function killAndWait(pid) {
  if (!pid) throw new Error('in-flight step PID is missing');
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
  await waitUntil('in-flight step process exit', () => !isProcessAlive(pid));
}

function isProcessAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
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
    process.stdout.write(
      `BLACK_BOX_ASSERTIONS: ${result.assertionsPassed}/${result.assertionsExpected}\n`,
    );
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
