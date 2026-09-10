// Pin the Git ref before submission; gate-snapshot extracts only its Git objects.
// The temporary execution directory is not a same-user filesystem sandbox.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const shellQuote = value => "'" + value.replaceAll("'", "'\\''") + "'";
export function prepareLocalDrive(flow, { root = process.cwd(),
  compiler = fileURLToPath(new URL('../packages/sdk/node_modules/typescript/bin/tsc', import.meta.url)) } = {}) {
  assert.equal(flow.name, 'drive-local', 'NOT_LOCAL_DRIVE');
  const git = (...args) => execFileSync('git', ['--no-replace-objects', ...args], { cwd: root, encoding: 'utf8' });
  const head = git('rev-parse', 'HEAD').trim();
  const baseline = {
    head,
    branch: git('branch', '--show-current').trim(),
    backlogSha256: createHash('sha256').update(git('show', `${head}:ops/BACKLOG.md`)).digest('hex'),
  };
  assert(baseline.branch && baseline.branch !== 'main', 'LOCAL_DRIVE_REFUSED: use a work branch');
  const snapshot = git('show', `${head}:ops/local-work-snapshot.mjs`);
  const directory = mkdtempSync(join(tmpdir(), 'drive-gate-'));
  const dispose = () => rmSync(directory, { recursive: true, force: true });
  try {
    const picker = pathToFileURL(join(directory, 'dist/backlog-picker.js')).href;
    const prefix = `GIT_NO_REPLACE_OBJECTS=1 DRIVE_GATE_BASELINE=${shellQuote(JSON.stringify(baseline))} ` +
      `DRIVE_GATE_PICKER=${shellQuote(picker)} ${shellQuote(process.execPath)} ` +
      shellQuote(join(directory, 'local-work-package.mjs'));
    const commands = Object.fromEntries(['select', 'scope', 'verify', 'report']
      .map(operation => [operation, `${prefix} ${operation}`]));
    const prepared = structuredClone(flow);
    const snapshotStep = prepared.steps.find(step => step.id === 'gate-snapshot');
    assert.equal(snapshotStep?.command, 'node ops/local-work-snapshot.mjs', 'DRIVE_SNAPSHOT_CHANGED');
    snapshotStep.command = `${shellQuote(process.execPath)} --input-type=module --eval ${shellQuote(snapshot)} ` +
      `local-drive-snapshot ${shellQuote(head)} ${shellQuote(directory)} ${shellQuote(resolve(compiler))}`;
    const operations = { select: 'select', 'initial-scope': 'scope', scope: 'scope',
      verify: 'verify', 'final-scope': 'scope', report: 'report' };
    for (const [id, operation] of Object.entries(operations)) {
      const step = prepared.steps.find(candidate => candidate.id === id);
      assert(step?.type === 'deterministic', `DRIVE_STEP_CHANGED: ${id}`);
      const call = `node ops/local-work-package.mjs ${operation}`;
      assert.equal(step.command.split(call).length, 2, `DRIVE_COMMAND_CHANGED: ${id}`);
      step.command = step.command.replace(call, commands[operation]);
    }
    return { flow: prepared, commands, baseline, directory, dispose };
  } catch (error) { dispose(); throw error; }
}
