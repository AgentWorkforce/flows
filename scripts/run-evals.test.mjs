import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import {
  collectProvenance,
  parseArgs,
  reportExitCode,
  runEvalSuite,
  validateEvalSuite,
  validateOutputPath,
} from './run-evals.mjs';

function suite(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'relayflows-eval',
    id: 'fixture-v1',
    defaultRepetitions: 2,
    minimumPublishableRepetitions: 2,
    environmentFailurePatterns: ['TOOLCHAIN_UNAVAILABLE'],
    cases: [
      {
        id: 'resume',
        claim: 'completed work is not repeated',
        command: { file: 'fixture', args: ['resume'], cwd: '../..', timeoutMs: 1000 },
        successWitnesses: [{ stream: 'stdout', contains: 'executed resume' }],
      },
    ],
    ...overrides,
  };
}

function withSuite(value, verify) {
  const root = mkdtempSync(join(tmpdir(), 'relayflows-eval-'));
  try {
    const directory = join(root, 'benchmarks', 'fixture');
    mkdirSync(directory, { recursive: true });
    const path = join(directory, 'suite.json');
    writeFileSync(path, `${JSON.stringify(value)}\n`);
    verify({ root, path: 'benchmarks/fixture/suite.json' });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function provenance(root, dirty = false) {
  return {
    source: {
      commit: 'a'.repeat(40),
      root,
      dirty,
      statusAvailable: true,
      statusPorcelain: dirty ? ' M file' : '',
    },
    runtime: { node: 'v1', rustc: 'rustc 1', cargo: 'cargo 1' },
    host: { platform: 'test', release: '1', arch: 'test', cpuModel: 'test', logicalCpus: 1 },
  };
}

test('rejects duplicate case ids', () => {
  const duplicate = suite();
  duplicate.cases.push({ ...duplicate.cases[0] });
  assert.throws(() => validateEvalSuite(duplicate), /duplicate eval case id/u);
});

test('validation names the malformed field', () => {
  const malformed = suite();
  malformed.cases[0].command.timeoutMs = 0;
  assert.throws(
    () => validateEvalSuite(malformed),
    /cases\[0\]\.command\.timeoutMs must be a positive integer/u,
  );
});

test('fails closed on a dirty tree by default', () => {
  withSuite(suite(), ({ root, path }) => {
    assert.throws(
      () => runEvalSuite({ rootDir: root, suitePath: path, provenance: provenance(root, true) }),
      /refusing to run a publishable eval from a dirty tree/u,
    );
  });
});

test('captures literal command output and marks an allowed dirty run ineligible', () => {
  withSuite(suite(), ({ root, path }) => {
    const report = runEvalSuite({
      rootDir: root,
      suitePath: path,
      provenance: provenance(root, true),
      allowDirty: true,
      execute: () => ({
        status: 0,
        signal: null,
        stdout: 'executed resume\nliteral stdout\n',
        stderr: 'literal stderr\n',
      }),
    });
    assert.equal(report.summary.passRate, 1);
    assert.equal(report.summary.publicationStatus, 'ineligible');
    assert.deepEqual(report.summary.blockers, ['source_tree_dirty']);
    assert.equal(report.cases[0].trials[0].stdout, 'executed resume\nliteral stdout\n');
    assert.equal(report.cases[0].trials[0].stderr, 'literal stderr\n');
    assert.equal(report.cases[0].trials[0].command.cwd, '../..');
  });
});

test('reports a failed trial without erasing its exit evidence', () => {
  withSuite(suite({ defaultRepetitions: 1, minimumPublishableRepetitions: 1 }), ({ root, path }) => {
    const report = runEvalSuite({
      rootDir: root,
      suitePath: path,
      provenance: provenance(root, false),
      execute: () => ({ status: 9, signal: null, stdout: 'partial\n', stderr: 'failed\n' }),
    });
    assert.equal(report.summary.publicationStatus, 'ineligible');
    assert.deepEqual(report.summary.blockers, ['trial_failures']);
    assert.equal(report.cases[0].trials[0].exitCode, 9);
    assert.equal(report.cases[0].trials[0].stderr, 'failed\n');
  });
});

test('only clean, passing, sufficiently repeated evidence is publication eligible', () => {
  withSuite(suite(), ({ root, path }) => {
    const report = runEvalSuite({
      rootDir: root,
      suitePath: path,
      provenance: provenance(root, false),
      execute: () => ({ status: 0, signal: null, stdout: 'executed resume\n', stderr: '' }),
    });
    assert.equal(report.summary.publicationStatus, 'eligible');
    assert.deepEqual(report.summary.blockers, []);
    assert.equal(report.summary.totalTrials, 2);
    assert.equal(report.cases[0].durationMs.p95, null);
    assert.match(report.suite.sha256, /^[a-f0-9]{64}$/u);
  });
});

test('zero exit without the execution witness is invalid, never passing', () => {
  withSuite(suite({ defaultRepetitions: 1, minimumPublishableRepetitions: 1 }), ({ root, path }) => {
    const report = runEvalSuite({
      rootDir: root,
      suitePath: path,
      provenance: provenance(root, false),
      execute: () => ({ status: 0, signal: null, stdout: 'running 0 tests\n', stderr: '' }),
    });
    assert.equal(report.cases[0].trials[0].outcome, 'invalid');
    assert.equal(report.summary.invalidTrials, 1);
    assert.deepEqual(report.summary.blockers, ['execution_witness_missing']);
  });
});

test('a recognized toolchain failure is inconclusive rather than a product failure', () => {
  withSuite(suite({ defaultRepetitions: 1, minimumPublishableRepetitions: 1 }), ({ root, path }) => {
    const report = runEvalSuite({
      rootDir: root,
      suitePath: path,
      provenance: provenance(root, false),
      execute: () => ({
        status: 127,
        signal: null,
        stdout: '',
        stderr: 'TOOLCHAIN_UNAVAILABLE\n',
      }),
    });
    assert.equal(report.cases[0].trials[0].outcome, 'inconclusive');
    assert.deepEqual(report.summary.blockers, ['environment_failures']);
  });
});

test('case cwd resolves relative to the suite and cannot escape the provenance root', () => {
  withSuite(suite(), ({ root, path }) => {
    const observed = [];
    runEvalSuite({
      rootDir: root,
      suitePath: path,
      provenance: provenance(root, false),
      execute: (_file, _args, options) => {
        observed.push(options.cwd);
        return { status: 0, signal: null, stdout: 'executed resume\n', stderr: '' };
      },
    });
    assert.deepEqual(observed, [root, root]);

    const escaping = suite();
    escaping.cases[0].command.cwd = '../../..';
    writeFileSync(join(root, path), `${JSON.stringify(escaping)}\n`);
    assert.throws(
      () =>
        runEvalSuite({
          rootDir: root,
          suitePath: path,
          provenance: provenance(root, false),
          execute: () => ({ status: 0, stdout: 'executed resume\n', stderr: '' }),
        }),
      /command cwd escapes the provenance root/u,
    );
  });
});

test('collectProvenance exercises clean, dirty, and unavailable git state', () => {
  const root = '/work/repo';
  const execute = (_file, args) => {
    const key = args.join(' ');
    if (key === 'rev-parse HEAD') return { status: 0, stdout: `${'b'.repeat(40)}\n` };
    if (key === 'status --porcelain=v1') return { status: 0, stdout: '' };
    if (key === 'rev-parse --show-toplevel') return { status: 0, stdout: `${root}\n` };
    return { status: 0, stdout: 'tool 1\n' };
  };
  const clean = collectProvenance(root, execute);
  assert.equal(clean.source.dirty, false);
  assert.equal(clean.source.commit, 'b'.repeat(40));
  assert.equal(clean.source.root, root);

  const dirty = collectProvenance(root, (file, args, options) => {
    if (args.join(' ') === 'status --porcelain=v1') return { status: 0, stdout: ' M file\n' };
    return execute(file, args, options);
  });
  assert.equal(dirty.source.dirty, true);
  assert.equal(dirty.source.statusPorcelain, 'M file');

  const unavailable = collectProvenance(root, () => ({ status: 128, stdout: '', stderr: 'not a repo' }));
  assert.equal(unavailable.source.dirty, true);
  assert.equal(unavailable.source.commit, null);
  assert.equal(unavailable.source.statusAvailable, false);
});

test('CLI parsing and exit policy fail closed for nonpublishable evidence', () => {
  assert.deepEqual(parseArgs(['--suite', 'suite.json', '--repeat', '30', '--allow-dirty']), {
    rootDir: process.cwd(),
    allowDirty: true,
    suitePath: 'suite.json',
    repetitions: 30,
  });
  assert.throws(() => parseArgs(['--unknown']), /unknown option/u);
  assert.equal(reportExitCode({ summary: { publicationStatus: 'eligible' } }), 0);
  assert.equal(reportExitCode({ summary: { publicationStatus: 'ineligible' } }), 1);
  assert.throws(
    () => validateOutputPath('/work/repo', 'evidence/result.json'),
    /output must be outside the source tree/u,
  );
  assert.doesNotThrow(() => validateOutputPath('/work/repo', '/tmp/result.json'));
});
