import assert from 'node:assert/strict';
import { spawnSync, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

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
  put('packages/sdk/src/backlog-picker.ts', readFileSync('packages/sdk/src/backlog-picker.ts'));
  put('packages/sdk/package.json', '{"type":"module"}\n');
  put('packages/sdk/tsconfig.json', JSON.stringify({
    compilerOptions: { target: 'ES2022', module: 'NodeNext', outDir: 'dist', skipLibCheck: true },
    include: ['src/backlog-picker.ts'],
  }));
  symlinkSync(resolve('packages/sdk/node_modules'), join(root, 'packages/sdk/node_modules'));
  git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test',
    '-c', 'commit.gpgsign=false', 'commit', '-qm', 'fixture');
  const step = id => spawnSync('sh', ['-c', flow.steps.find(s => s.id === id).command],
    { cwd: root, encoding: 'utf8', timeout: 10000 });
  const run = (operation, extra = []) => {
    const result = spawnSync(process.execPath,
      [...extra, 'ops/local-work-package.mjs', operation], { cwd: root, encoding: 'utf8', timeout: 5000 });
    if (operation === 'select' && result.status === 0) pass(step('gate-snapshot'));
    return result;
  };
  const scope = () => spawnSync('sh', ['-c', flow.steps.find(s => s.id === 'scope').command],
    { cwd: root, encoding: 'utf8', timeout: 5000 });
  return { root, put, git, run, scope, step };
}
export const pass = result => assert.equal(result.status, 0, result.stderr + result.stdout);
export const fail = (result, pattern) => {
  assert.notEqual(result.status, 0, result.stdout);
  if (pattern) assert.match(result.stderr + result.stdout, pattern);
};
