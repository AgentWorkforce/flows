import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';

import { collectProvenance } from './eval-provenance.mjs';

const RESULT_SCHEMA_VERSION = 1;
const INHERITED_ENV_KEYS = Object.freeze([
  'CARGO_HOME',
  'CARGO_TARGET_DIR',
  'HOME',
  'LANG',
  'LC_ALL',
  'PATH',
  'RELAYFLOWS_NO_TOOLCHAIN_INSTALL',
  'RELAYFLOWS_TOOLCHAIN_HOME',
  'RUSTUP_HOME',
  'RUSTUP_TOOLCHAIN',
  'SHELL',
  'TEMP',
  'TMP',
  'TMPDIR',
]);

export function validateEvalSuite(value) {
  if (!value || typeof value !== 'object') throw new Error('eval suite must be an object');
  if (value.schemaVersion !== 1) throw new Error('eval suite schemaVersion must be 1');
  if (value.kind !== 'relayflows-eval') throw new Error('eval suite kind must be relayflows-eval');
  requireNonEmptyString(value.id, 'eval suite id');
  requirePositiveInteger(value.defaultRepetitions, 'defaultRepetitions');
  requirePositiveInteger(value.minimumPublishableRepetitions, 'minimumPublishableRepetitions');
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
    validateCase(testCase, caseIndex, ids);
    ids.add(testCase.id);
  }
  return value;
}

function validateCase(testCase, caseIndex, ids) {
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
  if (!Array.isArray(testCase.command.args) || !testCase.command.args.every(isString)) {
    throw new Error(`cases[${caseIndex}].command.args must be an array of strings`);
  }
  requireNonEmptyString(testCase.command.cwd, `cases[${caseIndex}].command.cwd`);
  requirePositiveInteger(testCase.command.timeoutMs, `cases[${caseIndex}].command.timeoutMs`);
  if (testCase.command.env !== undefined) validateCommandEnv(testCase.command.env, caseIndex);
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
}

function validateCommandEnv(env, caseIndex) {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new Error(`cases[${caseIndex}].command.env must be an object`);
  }
  for (const [key, value] of Object.entries(env)) {
    requireNonEmptyString(key, `cases[${caseIndex}].command.env key`);
    if (typeof value !== 'string') {
      throw new Error(`cases[${caseIndex}].command.env.${key} must be a string`);
    }
  }
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
  validateProvenance(provenance, rootDir, options.allowDirty);
  const environment = trialEnvironment(options.parentEnv ?? process.env);
  const startedAt = new Date().toISOString();
  const cases = suite.cases.map((testCase) =>
    runCase({ testCase, suite, suitePath, rootDir, repetitions, execute, environment }),
  );
  return buildReport({ options, suite, suiteBytes, cases, repetitions, provenance, startedAt });
}

function validateProvenance(provenance, rootDir, allowDirty) {
  if (resolve(provenance.source.root) !== rootDir) {
    throw new Error(
      `provenance root ${provenance.source.root} does not match requested root ${rootDir}`,
    );
  }
  if (provenance.source.dirty && !allowDirty) {
    throw new Error(
      'refusing to run a publishable eval from a dirty tree; commit it or pass --allow-dirty',
    );
  }
}

function runCase({ testCase, suite, suitePath, rootDir, repetitions, execute, environment }) {
  const commandCwd = resolve(dirname(suitePath), testCase.command.cwd);
  if (!isWithin(rootDir, commandCwd)) {
    throw new Error(`case ${testCase.id} command cwd escapes the provenance root`);
  }
  const commandEnvironment = trialEnvironment(environment, testCase.command.env);
  const trials = Array.from({ length: repetitions }, (_, index) =>
    runTrial({
      testCase,
      repetition: index + 1,
      commandCwd,
      execute,
      environment: commandEnvironment,
      environmentFailurePatterns: suite.environmentFailurePatterns,
    }),
  );
  return summarizeCase(testCase, trials);
}

function runTrial({
  testCase,
  repetition,
  commandCwd,
  execute,
  environment,
  environmentFailurePatterns,
}) {
  const before = performance.now();
  const result = execute(testCase.command.file, testCase.command.args, {
    cwd: commandCwd,
    encoding: 'utf8',
    timeout: testCase.command.timeoutMs,
    maxBuffer: 64 * 1024 * 1024,
    env: environment,
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
    environmentFailurePatterns,
  });
  return {
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
      environment,
    },
    stdout,
    stderr,
    missingWitnesses,
    error: result.error ? String(result.error.message ?? result.error) : null,
  };
}

function classifyTrial({ result, stdout, stderr, missingWitnesses, environmentFailurePatterns }) {
  if (result.status === 0) return missingWitnesses.length === 0 ? 'passed' : 'invalid';
  if (result.error?.code === 'ETIMEDOUT') return 'timed_out';
  const combined = `${stdout}\n${stderr}\n${result.error?.message ?? ''}`;
  if (
    result.status === 127 ||
    environmentFailurePatterns.some((pattern) => combined.includes(pattern))
  ) {
    return 'inconclusive';
  }
  return 'failed';
}

function summarizeCase(testCase, trials) {
  const durations = trials.filter((trial) => trial.passed).map((trial) => trial.durationMs);
  const count = (outcome) => trials.filter((trial) => trial.outcome === outcome).length;
  const passedTrials = count('passed');
  return {
    id: testCase.id,
    claim: testCase.claim,
    passedTrials,
    failedTrials: count('failed'),
    timedOutTrials: count('timed_out'),
    invalidTrials: count('invalid'),
    inconclusiveTrials: count('inconclusive'),
    totalTrials: trials.length,
    passRate: passedTrials / trials.length,
    durationMs: {
      sampleSize: durations.length,
      p50: durations.length > 0 ? percentile(durations, 0.5) : null,
      p95: durations.length >= 20 ? percentile(durations, 0.95) : null,
    },
    trials,
  };
}

function buildReport({ options, suite, suiteBytes, cases, repetitions, provenance, startedAt }) {
  const count = (field) => cases.reduce((sum, testCase) => sum + testCase[field], 0);
  const summary = {
    passedTrials: count('passedTrials'),
    failedTrials: count('failedTrials'),
    timedOutTrials: count('timedOutTrials'),
    invalidTrials: count('invalidTrials'),
    inconclusiveTrials: count('inconclusiveTrials'),
    totalTrials: count('totalTrials'),
  };
  const blockers = publicationBlockers({ ...summary, repetitions, suite, provenance });
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
      ...summary,
      passRate: summary.passedTrials / summary.totalTrials,
      publicationStatus: blockers.length === 0 ? 'eligible' : 'ineligible',
      blockers,
    },
    cases,
  };
}

function publicationBlockers(summary) {
  const blockers = [];
  if (summary.provenance.source.dirty) blockers.push('source_tree_dirty');
  if (summary.repetitions < summary.suite.minimumPublishableRepetitions) {
    blockers.push('insufficient_repetitions');
  }
  if (summary.failedTrials > 0) blockers.push('trial_failures');
  if (summary.timedOutTrials > 0) blockers.push('trial_timeouts');
  if (summary.invalidTrials > 0) blockers.push('execution_witness_missing');
  if (summary.inconclusiveTrials > 0) blockers.push('environment_failures');
  return blockers;
}

export function trialEnvironment(parentEnv, commandEnv = {}) {
  const environment = {};
  for (const key of INHERITED_ENV_KEYS) {
    if (parentEnv[key] !== undefined) environment[key] = String(parentEnv[key]);
  }
  return { ...environment, ...commandEnv, CARGO_TERM_COLOR: 'never' };
}

function percentile(values, quantile) {
  const sorted = [...values].sort((left, right) => left - right);
  const index = Math.max(0, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index];
}

export function isWithin(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !path.startsWith('/'));
}

function requireNonEmptyString(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`${field} must be a non-empty string`);
  }
}

function requirePositiveInteger(value, field) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${field} must be a positive integer`);
}

function isString(value) {
  return typeof value === 'string';
}

function text(value) {
  if (value === undefined || value === null) return '';
  return Buffer.isBuffer(value) ? value.toString('utf8') : String(value);
}
