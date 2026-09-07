// The smallest useful local drive package: a mechanical change from BACKLOG.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const target = 'packages/sdk/src/compile.ts';
const packagePath = '.relayflow/drive-local/package.json';
const oldName = 'validateKernelRetry';
const newName = 'validateAuthoringRetryDefaults';
const hash = text => createHash('sha256').update(text).digest('hex');
const read = path => readFileSync(path, 'utf8');
const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim();

switch (process.argv[2]) {
  case 'select': {
    const branch = git('branch', '--show-current');
    assert(branch && branch !== 'main', 'LOCAL_DRIVE_REFUSED: use a work branch');
    assert.equal(git('status', '--porcelain', '--', target), '', 'LOCAL_DRIVE_REFUSED: target has uncommitted edits');
    const entry = read('ops/BACKLOG.md').match(/^- \*\*F8b\*\*[^\n]*(?:\n  [^\n]*)*/m)?.[0];
    assert(entry?.includes(oldName), 'BACKLOG_F8B_MISSING: expected the recorded work item');
    const source = read(target);
    assert.equal(source.split(oldName).length - 1, 2, 'PACKAGE_ALREADY_APPLIED_OR_CHANGED: expected declaration and call');
    const work = { id: 'F8b', entry, branch, target, before: hash(source), after: hash(source.replaceAll(oldName, newName)) };
    mkdirSync('.relayflow/drive-local', { recursive: true });
    writeFileSync(packagePath, JSON.stringify(work, null, 2) + '\n');
    assert.equal(JSON.parse(read(packagePath)).before, work.before);
    console.log(JSON.stringify(work));
    break;
  }
  case 'apply': {
    const work = JSON.parse(read(packagePath));
    assert.equal(git('branch', '--show-current'), work.branch, 'work branch changed');
    const before = read(target);
    // A retry after an interrupted write can observe the exact intended end state.
    if (hash(before) === work.after) { console.log('PACKAGE_ALREADY_APPLIED: F8b'); break; }
    assert.equal(hash(before), work.before, 'TARGET_CHANGED: refusing to overwrite intervening work');
    const after = before.replaceAll(oldName, newName);
    assert.notEqual(after, before);
    writeFileSync(target, after);
    assert.equal(hash(read(target)), work.after, 'MUTATION_NOT_PERSISTED');
    console.log(`PACKAGE_APPLIED: F8b ${work.before} -> ${work.after}`);
    console.log(git('diff', '--', target));
    break;
  }
  case 'report': {
    const work = JSON.parse(read(packagePath));
    assert.equal(hash(read(target)), work.after, 'TARGET_CHANGED: expected the applied package');
    const diff = git('diff', '--', target);
    assert(diff.includes(`+function ${newName}(`), 'PACKAGE_DIFF_MISSING');
    console.log('PACKAGE_EXECUTED: F8b; delivery requires a branch commit and human-reviewed PR.');
    console.log(diff);
    break;
  }
  default: throw new Error('Usage: node ops/local-work-package.mjs <select|apply|report>');
}
