import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { runEvalSuite, validateEvalSuite } from './run-evals.mjs';

function suite(overrides = {}) {
  return {
    schemaVersion: 1,
    kind: 'relayflows-eval',
    id: 'fixture-v1',
    defaultRepetitions: 2,
    minimumPublishableRepetitions: 2,
    cases: [
      {
        id: 'resume',
        claim: 'completed work is not repeated',
        command: { file: 'fixture', args: ['resume'], cwd: '../..', timeoutMs: 1000 },
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

function provenance(dirty = false) {
  return {
    source: { commit: 'a'.repeat(40), dirty, statusPorcelain: dirty ? ' M file' : '' },
    runtime: { node: 'v1', rustc: 'rustc 1', cargo: 'cargo 1' },
    host: { platform: 'test', release: '1', arch: 'test', cpuModel: 'test', logicalCpus: 1 },
  };
}

test('rejects duplicate case ids', () => {
  const duplicate = suite();
  duplicate.cases.push({ ...duplicate.cases[0] });
  assert.throws(() => validateEvalSuite(duplicate), /invalid or duplicate case/u);
});

test('fails closed on a dirty tree by default', () => {
  withSuite(suite(), ({ root, path }) => {
    assert.throws(
      () => runEvalSuite({ rootDir: root, suitePath: path, provenance: provenance(true) }),
      /refusing to run a publishable eval from a dirty tree/u,
    );
  });
});

test('captures literal command output and marks an allowed dirty run ineligible', () => {
  withSuite(suite(), ({ root, path }) => {
    const report = runEvalSuite({
      rootDir: root,
      suitePath: path,
      provenance: provenance(true),
      allowDirty: true,
      execute: () => ({ status: 0, signal: null, stdout: 'literal stdout\n', stderr: 'literal stderr\n' }),
    });
    assert.equal(report.summary.passRate, 1);
    assert.equal(report.summary.publicationStatus, 'ineligible');
    assert.deepEqual(report.summary.blockers, ['source_tree_dirty']);
    assert.equal(report.cases[0].trials[0].stdout, 'literal stdout\n');
    assert.equal(report.cases[0].trials[0].stderr, 'literal stderr\n');
    assert.equal(report.cases[0].trials[0].command.cwd, '../..');
  });
});

test('reports a failed trial without erasing its exit evidence', () => {
  withSuite(suite({ defaultRepetitions: 1, minimumPublishableRepetitions: 1 }), ({ root, path }) => {
    const report = runEvalSuite({
      rootDir: root,
      suitePath: path,
      provenance: provenance(false),
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
      provenance: provenance(false),
      execute: () => ({ status: 0, signal: null, stdout: 'ok\n', stderr: '' }),
    });
    assert.equal(report.summary.publicationStatus, 'eligible');
    assert.deepEqual(report.summary.blockers, []);
    assert.equal(report.summary.totalTrials, 2);
    assert.match(report.suite.sha256, /^[a-f0-9]{64}$/u);
  });
});
