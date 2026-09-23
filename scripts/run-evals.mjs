#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const RESULT_SCHEMA_VERSION = 1;

export function validateEvalSuite(value) {
  if (!value || typeof value !== 'object') throw new Error('eval suite must be an object');
  if (value.schemaVersion !== 1) throw new Error('eval suite schemaVersion must be 1');
  if (value.kind !== 'relayflows-eval') throw new Error('eval suite kind must be relayflows-eval');
  requireNonEmptyString(value.id, 'eval suite id');
  requirePositiveInteger(value.defaultRepetitions, 'defaultRepetitions');
  requirePositiveInteger(
    value.minimumPublishableRepetitions,
    'minimumPublishableRepetitions',
  );
  if (!Array.isArray(value.environmentFailurePatterns)) {
    throw new Error('environmentFailurePatterns must be an array');
  }
  value.environmentFailurePatterns.forEach((pattern, index) =>
    requireNonEmptyString(pattern, `environmentFailurePatterns[${index}]`),
  );
  if (!Array.isArray(value.cases) || value.cases.length === 0) {
    throw new Error('eval suite cases must be a non-empty array');
  }

  const ids = new Set();
  for (const [caseIndex, testCase] of value.cases.entries()) {
    if (!testCase || typeof testCase !== 'object') {
      throw new Error(`cases[${caseIndex}] must be an object`);
    }
    requireNonEmptyString(testCase.id, `cases[${caseIndex}].id`);
    if (ids.has(testCase.id)) throw new Error(`duplicate eval case id: ${testCase.id}`);
    requireNonEmptyString(testCase.claim, `cases[${caseIndex}].claim`);
    if (!testCase.command || typeof testCase.command !== 'object') {
      throw new Error(`cases[${caseIndex}].command must be an object`);
    }
    requireNonEmptyString(testCase.command.file, `cases[${caseIndex}].command.file`);
    if (
      !Array.isArray(testCase.command.args) ||
      !testCase.command.args.every((arg) => typeof arg === 'string')
    ) {
      throw new Error(`cases[${caseIndex}].command.args must be an array of strings`);
    }
    requireNonEmptyString(testCase.command.cwd, `cases[${caseIndex}].command.cwd`);
    requirePositiveInteger(testCase.command.timeoutMs, `cases[${caseIndex}].command.timeoutMs`);
    if (!Array.isArray(testCase.successWitnesses) || testCase.successWitnesses.length === 0) {
      throw new Error(`cases[${caseIndex}].successWitnesses must be a non-empty array`);
    }
    for (const [witnessIndex, witness] of testCase.successWitnesses.entries()) {
      if (!witness || !['stdout', 'stderr'].includes(witness.stream)) {
        throw new Error(
          `cases[${caseIndex}].successWitnesses[${witnessIndex}].stream must be stdout or stderr`,
        );
      }
      requireNonEmptyString(
        witness.contains,
        `cases[${caseIndex}].successWitnesses[${witnessIndex}].contains`,
      );
    }
    ids.add(testCase.id);
  }
  return value;
}

export function runEvalSuite(options) {
  const rootDir = resolve(options.rootDir ?? process.cwd());
  const suitePath = resolve(rootDir, options.suitePath);
  const suiteBytes = readFileSync(suitePath);
  const suite = validateEvalSuite(JSON.parse(suiteBytes.toString('utf8')));
  const repetitions = options.repetitions ?? suite.defaultRepetitions;
  if (!Number.isInteger(repetitions) || repetitions < 1) {
    throw new Error('repetitions must be a positive integer');
  }

  const execute = options.execute ?? spawnSync;
  const provenance = options.provenance ?? collectProvenance(rootDir, execute);
  if (resolve(provenance.source.root) !== rootDir) {
    throw new Error(
      `provenance root ${provenance.source.root} does not match requested root ${rootDir}`,
    );
  }
  if (provenance.source.dirty && !options.allowDirty) {
    throw new Error('refusing to run a publishable eval from a dirty tree; commit it or pass --allow-dirty');
  }

  const startedAt = new Date().toISOString();
  const cases = suite.cases.map((testCase) => {
    const commandCwd = resolve(dirname(suitePath), testCase.command.cwd);
    if (!isWithin(rootDir, commandCwd)) {
      throw new Error(`case ${testCase.id} command cwd escapes the provenance root`);
    }
    const trials = [];
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const before = performance.now();
      const result = execute(testCase.command.file, testCase.command.args, {
        cwd: commandCwd,
        encoding: 'utf8',
        timeout: testCase.command.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: process.env,
      });
      const durationMs = Math.round((performance.now() - before) * 1000) / 1000;
      const stdout = text(result.stdout);
      const stderr = text(result.stderr);
      const missingWitnesses = testCase.successWitnesses.filter(
        (witness) => !{ stdout, stderr }[witness.stream].includes(witness.contains),
      );
      const outcome = classifyTrial({
        result,
        stdout,
        stderr,
        missingWitnesses,
        environmentFailurePatterns: suite.environmentFailurePatterns,
      });
      trials.push({
        repetition,
        outcome,
        passed: outcome === 'passed',
        exitCode: result.status,
        signal: result.signal ?? null,
        durationMs,
        command: {
          file: testCase.command.file,
          args: testCase.command.args,
          cwd: testCase.command.cwd,
        },
        stdout,
        stderr,
        missingWitnesses,
        error: result.error ? String(result.error.message ?? result.error) : null,
      });
    }
    const durations = trials.filter((trial) => trial.passed).map((trial) => trial.durationMs);
    const passedTrials = trials.filter((trial) => trial.passed).length;
    const failedTrials = trials.filter((trial) => trial.outcome === 'failed').length;
    const invalidTrials = trials.filter((trial) => trial.outcome === 'invalid').length;
    const inconclusiveTrials = trials.filter((trial) => trial.outcome === 'inconclusive').length;
    return {
      id: testCase.id,
      claim: testCase.claim,
      passedTrials,
      failedTrials,
      invalidTrials,
      inconclusiveTrials,
      totalTrials: trials.length,
      passRate: passedTrials / trials.length,
      durationMs: {
        sampleSize: durations.length,
        p50: durations.length > 0 ? percentile(durations, 0.5) : null,
        p95: durations.length >= 20 ? percentile(durations, 0.95) : null,
      },
      trials,
    };
  });

  const totalTrials = cases.reduce((sum, testCase) => sum + testCase.totalTrials, 0);
  const passedTrials = cases.reduce((sum, testCase) => sum + testCase.passedTrials, 0);
  const failedTrials = cases.reduce((sum, testCase) => sum + testCase.failedTrials, 0);
  const invalidTrials = cases.reduce((sum, testCase) => sum + testCase.invalidTrials, 0);
  const inconclusiveTrials = cases.reduce(
    (sum, testCase) => sum + testCase.inconclusiveTrials,
    0,
  );
  const blockers = [];
  if (provenance.source.dirty) blockers.push('source_tree_dirty');
  if (repetitions < suite.minimumPublishableRepetitions) blockers.push('insufficient_repetitions');
  if (failedTrials > 0) blockers.push('trial_failures');
  if (invalidTrials > 0) blockers.push('execution_witness_missing');
  if (inconclusiveTrials > 0) blockers.push('environment_failures');

  return {
    schemaVersion: RESULT_SCHEMA_VERSION,
    kind: 'relayflows-eval-result',
    suite: {
      id: suite.id,
      path: options.suitePath,
      sha256: createHash('sha256').update(suiteBytes).digest('hex'),
    },
    implementation: options.implementation ?? 'relayflows',
    startedAt,
    completedAt: new Date().toISOString(),
    repetitions,
    provenance,
    summary: {
      passedTrials,
      failedTrials,
      invalidTrials,
      inconclusiveTrials,
      totalTrials,
      passRate: passedTrials / totalTrials,
      publicationStatus: blockers.length === 0 ? 'eligible' : 'ineligible',
      blockers,
    },
    cases,
  };
}

export function collectProvenance(rootDir, execute = spawnSync) {
  const gitCommit = commandResult(execute, 'git', ['rev-parse', 'HEAD'], rootDir);
  const gitStatus = commandResult(execute, 'git', ['status', '--porcelain=v1'], rootDir);
  const gitRoot = commandResult(execute, 'git', ['rev-parse', '--show-toplevel'], rootDir);
  const cpu = cpus();
  return {
    source: {
      commit: gitCommit.ok ? gitCommit.stdout : null,
      root: gitRoot.ok ? resolve(gitRoot.stdout) : rootDir,
      dirty: !gitCommit.ok || !gitStatus.ok || !gitRoot.ok || gitStatus.stdout.length > 0,
      statusAvailable: gitStatus.ok,
      statusPorcelain: gitStatus.stdout,
    },
    runtime: {
      node: process.version,
      rustc: commandText(execute, 'rustc', ['--version'], rootDir) || null,
      cargo: commandText(execute, resolve(rootDir, 'ops/cargo.sh'), ['--version'], rootDir) || null,
    },
    host: {
      platform: platform(),
      release: release(),
      arch: process.arch,
      cpuModel: cpu[0]?.model ?? null,
      logicalCpus: cpu.length,
    },
  };
}

function classifyTrial({
  result,
  stdout,
  stderr,
  missingWitnesses,
  environmentFailurePatterns,
}) {
  if (result.status === 0) return missingWitnesses.length === 0 ? 'passed' : 'invalid';
  const combined = `${stdout}\n${stderr}\n${result.error?.message ?? ''}`;
  if (
    result.error ||
    result.status === 127 ||
    environmentFailurePatterns.some((pattern) => combined.includes(pattern))
  ) {
    return 'inconclusive';
  }
  return 'failed';
}

function commandText(execute, file, args, cwd) {
  const result = execute(file, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) return '';
  return text(result.stdout).trim();
}

function commandResult(execute, file, args, cwd) {
  const result = execute(file, args, { cwd, encoding: 'utf8' });
  return {
    ok: result.status === 0,
    stdout: result.status === 0 ? text(result.stdout).trim() : '',
  };
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index];
}

function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'));
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be a positive integer`);
  }
}

function text(value) {
  if (value === undefined || value === null) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

export function parseArgs(argv) {
  const options = { rootDir: process.cwd(), allowDirty: false };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--allow-dirty') {
      options.allowDirty = true;
      continue;
    }
    if (!['--suite', '--output', '--implementation', '--repeat', '--root'].includes(arg)) {
      throw new Error(`unknown option: ${arg}`);
    }
    const value = argv[index + 1];
    if (!value) throw new Error(`missing value for ${arg}`);
    index += 1;
    if (arg === '--suite') options.suitePath = value;
    if (arg === '--output') options.output = value;
    if (arg === '--implementation') options.implementation = value;
    if (arg === '--repeat') options.repetitions = Number(value);
    if (arg === '--root') options.rootDir = value;
  }
  if (!options.suitePath) throw new Error('missing required option --suite');
  return options;
}

export function reportExitCode(report) {
  return report.summary.publicationStatus === 'eligible' ? 0 : 1;
}

export function validateOutputPath(rootDir, output) {
  if (output && isWithin(resolve(rootDir), resolve(rootDir, output))) {
    throw new Error('report output must be outside the source tree so it cannot dirty later runs');
  }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    validateOutputPath(options.rootDir, options.output);
    const report = runEvalSuite(options);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) writeFileSync(resolve(options.rootDir, options.output), json);
    else process.stdout.write(json);
    process.stderr.write(
      `${report.suite.id}: ${report.summary.passedTrials}/${report.summary.totalTrials} trials passed; ` +
        `publication ${report.summary.publicationStatus}\n`,
    );
    process.exitCode = reportExitCode(report);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
