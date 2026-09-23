#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { cpus, platform, release } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';

const RESULT_SCHEMA_VERSION = 1;

export function validateEvalSuite(value) {
  if (
    !value ||
    typeof value !== 'object' ||
    value.schemaVersion !== 1 ||
    value.kind !== 'relayflows-eval' ||
    typeof value.id !== 'string' ||
    value.id.length === 0 ||
    !Number.isInteger(value.defaultRepetitions) ||
    value.defaultRepetitions < 1 ||
    !Number.isInteger(value.minimumPublishableRepetitions) ||
    value.minimumPublishableRepetitions < 1 ||
    !Array.isArray(value.cases) ||
    value.cases.length === 0
  ) {
    throw new Error('eval suite has an unsupported or incomplete schema');
  }

  const ids = new Set();
  for (const testCase of value.cases) {
    if (
      !testCase ||
      typeof testCase.id !== 'string' ||
      testCase.id.length === 0 ||
      ids.has(testCase.id) ||
      typeof testCase.claim !== 'string' ||
      testCase.claim.length === 0 ||
      !testCase.command ||
      typeof testCase.command.file !== 'string' ||
      testCase.command.file.length === 0 ||
      !Array.isArray(testCase.command.args) ||
      !testCase.command.args.every((arg) => typeof arg === 'string') ||
      typeof testCase.command.cwd !== 'string' ||
      !Number.isInteger(testCase.command.timeoutMs) ||
      testCase.command.timeoutMs < 1
    ) {
      throw new Error(`eval suite contains an invalid or duplicate case: ${testCase?.id ?? '<missing>'}`);
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
  if (provenance.source.dirty && !options.allowDirty) {
    throw new Error('refusing to run a publishable eval from a dirty tree; commit it or pass --allow-dirty');
  }

  const startedAt = new Date().toISOString();
  const cases = suite.cases.map((testCase) => {
    const trials = [];
    for (let repetition = 1; repetition <= repetitions; repetition += 1) {
      const before = performance.now();
      const result = execute(testCase.command.file, testCase.command.args, {
        cwd: resolve(dirname(suitePath), testCase.command.cwd),
        encoding: 'utf8',
        timeout: testCase.command.timeoutMs,
        maxBuffer: 64 * 1024 * 1024,
        env: { ...process.env, CARGO_TERM_COLOR: 'never' },
      });
      const durationMs = Math.round((performance.now() - before) * 1000) / 1000;
      trials.push({
        repetition,
        passed: result.status === 0,
        exitCode: result.status,
        signal: result.signal ?? null,
        durationMs,
        command: {
          file: testCase.command.file,
          args: testCase.command.args,
          cwd: testCase.command.cwd,
        },
        stdout: text(result.stdout),
        stderr: text(result.stderr),
        error: result.error ? String(result.error.message ?? result.error) : null,
      });
    }
    const durations = trials.map((trial) => trial.durationMs);
    const passedTrials = trials.filter((trial) => trial.passed).length;
    return {
      id: testCase.id,
      claim: testCase.claim,
      passedTrials,
      totalTrials: trials.length,
      passRate: passedTrials / trials.length,
      durationMs: {
        p50: percentile(durations, 0.5),
        p95: percentile(durations, 0.95),
      },
      trials,
    };
  });

  const totalTrials = cases.reduce((sum, testCase) => sum + testCase.totalTrials, 0);
  const passedTrials = cases.reduce((sum, testCase) => sum + testCase.passedTrials, 0);
  const blockers = [];
  if (provenance.source.dirty) blockers.push('source_tree_dirty');
  if (repetitions < suite.minimumPublishableRepetitions) blockers.push('insufficient_repetitions');
  if (passedTrials !== totalTrials) blockers.push('trial_failures');

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
  const cpu = cpus();
  return {
    source: {
      commit: gitCommit.ok ? gitCommit.stdout : null,
      dirty: !gitStatus.ok || gitStatus.stdout.length > 0,
      statusAvailable: gitStatus.ok,
      statusPorcelain: gitStatus.stdout,
    },
    runtime: {
      node: process.version,
      rustc: commandText(execute, 'rustc', ['--version'], rootDir) || null,
      cargo: commandText(execute, 'cargo', ['--version'], rootDir) || null,
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

function text(value) {
  if (value === undefined || value === null) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}

function parseArgs(argv) {
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

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    const report = runEvalSuite(options);
    const json = `${JSON.stringify(report, null, 2)}\n`;
    if (options.output) writeFileSync(resolve(options.rootDir, options.output), json);
    else process.stdout.write(json);
    process.stderr.write(
      `${report.suite.id}: ${report.summary.passedTrials}/${report.summary.totalTrials} trials passed; ` +
        `publication ${report.summary.publicationStatus}\n`,
    );
    process.exitCode = report.summary.passedTrials === report.summary.totalTrials ? 0 : 1;
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) main();
