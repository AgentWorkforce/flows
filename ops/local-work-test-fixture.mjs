import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { prepareLocalDrive, shellQuote } from './local-work-gate.mjs';

// Resolve the SDK's declared YAML dependency through its public package entry,
// allowing Node to find either a local install or a hoisted dependency.
const { load } = createRequire(new URL('../packages/sdk/package.json', import.meta.url))('js-yaml');

export const flow = load(readFileSync('workflows/drive-local.yaml', 'utf8'));
export const packagePath = '.relayflow/drive-local/package.json';
const check = ['node', '-e', "require('node:assert/strict').equal(require('node:fs').readFileSync('src/value.txt','utf8'),'fixed')"];
export const entry = (title = 'Fix value', path = 'src/value.txt', commands = [check]) =>
  `- **${title}** Update \`${path}\` to the required value.\n` +
  commands.map(argv => `  Verify: ${JSON.stringify(argv)}\n`).join('');

export function fixture(t, backlog = entry()) {
  mkdirSync('.relayflow', { recursive: true });
  const root = mkdtempSync(resolve('.relayflow/package-tests-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (path, content) => {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), content);
  };
  const git = (...args) => execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-q', '-b', 'work');
  put('.gitignore', '.relayflow/\n.drive-gate/\npackages/sdk/dist/\nnode_modules/\n');
  put('src/value.txt', 'broken');
  put('outside.txt', 'original');
  put('ops/BACKLOG.md', backlog);
  for (const path of ['ops/local-work-package.mjs', 'ops/local-work-verification.mjs', 'workflows/drive-local.yaml']) {
    put(path, readFileSync(path));
  }
  put('packages/sdk/dist/backlog-picker.js', readFileSync('packages/sdk/dist/backlog-picker.js'));
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  let captured = prepareLocalDrive(flow, { root });
  const step = id => spawnSync('sh', ['-c', captured.flow.steps.find(s => s.id === id).command],
    { cwd: root, encoding: 'utf8', timeout: 10000 });
  const run = (operation, extra = []) => {
    if (operation === 'select') captured = prepareLocalDrive(flow, { root });
    const command = captured.commands[operation].replace('--input-type=module',
      `${extra.map(shellQuote).join(' ')} --input-type=module`);
    const result = spawnSync('sh', ['-c', command], { cwd: root, encoding: 'utf8', timeout: 5000 });
    return result;
  };
  const scope = () => step('scope');
  return { root, put, git, run, scope, step, get preparedFlow() { return captured.flow; } };
}
export const pass = result => assert.equal(result.status, 0, result.stderr + result.stdout);
export const fail = (result, pattern) => {
  assert.notEqual(result.status, 0, result.stdout);
  if (pattern) assert.match(result.stderr + result.stdout, pattern);
};
