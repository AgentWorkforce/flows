// Capture the judge in the submitted spec, before the implementation can run.
// The daemon executes these command bytes from its journal, not from a mutable
// checkout copy or a checksum file stored beside that copy.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
const moduleUrl = source => `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`;

export function prepareLocalDrive(flow, { root = process.cwd() } = {}) {
  assert.equal(flow.name, 'drive-local', 'NOT_LOCAL_DRIVE');
  const read = path => readFileSync(join(root, path), 'utf8');
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  const baseline = {
    head: git('rev-parse', 'HEAD'),
    branch: git('branch', '--show-current'),
    backlogSha256: createHash('sha256').update(read('ops/BACKLOG.md')).digest('hex'),
  };
  assert(baseline.branch && baseline.branch !== 'main', 'LOCAL_DRIVE_REFUSED: use a work branch');
  const dependency = "'./local-work-verification.mjs'";
  const source = read('ops/local-work-package.mjs');
  assert.equal(source.split(dependency).length, 2, 'GATE_IMPORT_CHANGED');
  const gate = source.replace(dependency, JSON.stringify(moduleUrl(read('ops/local-work-verification.mjs'))));
  const picker = moduleUrl(read('packages/sdk/dist/backlog-picker.js'));
  const prefix = `DRIVE_GATE_BASELINE=${shellQuote(JSON.stringify(baseline))} ` +
    `DRIVE_GATE_PICKER=${shellQuote(picker)} ${shellQuote(process.execPath)} ` +
    `--input-type=module --eval ${shellQuote(gate)} local-drive-gate`;
  const commands = Object.fromEntries(['select', 'scope', 'verify', 'report']
    .map(operation => [operation, `${prefix} ${operation}`]));
  const prepared = structuredClone(flow);
  const operations = { select: 'select', 'gate-snapshot': 'scope', scope: 'scope',
    verify: 'verify', 'final-scope': 'scope', report: 'report' };
  for (const [id, operation] of Object.entries(operations)) {
    const step = prepared.steps.find(candidate => candidate.id === id);
    assert(step?.type === 'deterministic', `DRIVE_STEP_CHANGED: ${id}`);
    const call = `node ops/local-work-package.mjs ${operation}`;
    assert.equal(step.command.split(call).length, 2, `DRIVE_COMMAND_CHANGED: ${id}`);
    step.command = step.command.replace(call, commands[operation]);
  }
  return { flow: prepared, commands, baseline };
}
