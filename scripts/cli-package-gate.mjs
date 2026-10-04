#!/usr/bin/env node
// Requires built surface + SDK. Install real release tarballs outside the repo.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const [major, minor] = process.versions.node.split('.').map(Number);
assert(major > 22 || (major === 22 && minor >= 18),
  'CLI packaging gate requires Node >=22.18.0 for .flow.ts type stripping; the published engines range is broader than this authored-flow requirement.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(root, 'packages/sdk/package.json'));
const ts = require('typescript');
const fixture = 'dependency-upgrade-bot.flow.ts';
const source = readFileSync(join(root, 'examples/dependency-upgrade-bot', fixture), 'utf8');
const imports = new Set();
function visit(node) {
  if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
    if (node.moduleSpecifier) imports.add(node.moduleSpecifier.text);
  }
  if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword ||
    node.expression.getText() === 'require')) imports.add(node.arguments[0]?.text);
  ts.forEachChild(node, visit);
}
visit(ts.createSourceFile(fixture, source, ts.ScriptTarget.Latest, true));
assert.deepEqual([...imports], ['@relayflows/surface'],
  'Packaging fixture must import only @relayflows/surface; consider task-graph, social-post-pipeline, pr-review-pipeline, or software-factory.');
const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'flows-cli-package-')));
const env = { ...process.env };
for (const key of ['NODE_PATH', 'NODE_OPTIONS', 'GITHUB_OUTPUT']) delete env[key];
function run(command, args, cwd = root) {
  console.log(`$ ${command} ${args.join(' ')}`);
  try {
    const output = execFileSync(command, args, { cwd, env, encoding: 'utf8', timeout: 60_000, stdio: ['ignore', 'pipe', 'pipe'] });
    process.stdout.write(output);
    return output;
  } catch (error) {
    process.stdout.write(error.stdout ?? '');
    process.stderr.write(error.stderr ?? '');
    throw error;
  }
}
function project(name) {
  const directory = join(temporary, name);
  mkdirSync(join(directory, 'examples'), { recursive: true });
  writeFileSync(join(directory, 'package.json'), '{"private":true,"type":"module"}\n');
  writeFileSync(join(directory, 'examples', fixture), source);
  return directory;
}
function check(binary, directory, args = []) {
  const output = run(binary, [...args, 'check', `examples/${fixture}`], directory);
  assert.match(output, /CHECK PASSED/);
}
function resolvedInside(manifest, boundary) {
  const resolved = realpathSync(createRequire(manifest).resolve('typescript'));
  assert(resolved.startsWith(`${boundary}${sep}`), `TypeScript resolved outside install: ${resolved}`);
}
try {
  // Reject contaminated temp roots as well as temp directories inside the repo.
  assert(!temporary.startsWith(`${root}${sep}`), 'Temp directory must be outside the repository');
  for (let parent = dirname(temporary); ; parent = dirname(parent)) {
    assert(!existsSync(join(parent, 'node_modules')), `Ancestor node_modules contaminates packaging test: ${parent}`);
    if (parent === dirname(parent)) break;
  }
  const tarballs = join(temporary, 'tarballs');
  for (const name of ['surface', 'sdk', 'relayflows']) {
    run(process.execPath, ['scripts/pack-release.mjs', name, tarballs]);
  }
  const archives = readdirSync(tarballs).filter(name => name.endsWith('.tgz')).map(name => join(tarballs, name));
  assert.equal(archives.length, 3);
  // Optional platform binaries are unrelated to Node dependency resolution.
  const flags = ['--ignore-scripts', '--omit=optional', '--no-audit', '--no-fund'];
  const local = project('local');
  run('npm', ['install', ...flags, ...archives], local);
  check(join(local, 'node_modules/.bin/flows'), local);
  check(process.execPath, local, [join(local, 'node_modules/relayflows/bin/flows.js')]);
  resolvedInside(join(local, 'node_modules/@relayflows/sdk/package.json'), local);

  const prefix = join(temporary, 'prefix');
  run('npm', ['install', '-g', '--prefix', prefix, ...flags, ...archives], temporary);
  assert.deepEqual(readdirSync(join(prefix, 'bin')).sort(), ['flows'], 'Global install must not expose tsc or tsserver');
  // Both SDK and wrapper own a flows bin; also exercise the wrapper explicitly.
  const wrapper = join(prefix, 'lib/node_modules/relayflows');
  const globalProject = project('global-project');
  const surface = archives.find(path => path.endsWith(`/relayflows-surface-${require('./package.json').version}.tgz`));
  assert(surface, 'Missing surface archive');
  run('npm', ['install', ...flags, surface], globalProject);
  assert(!existsSync(join(globalProject, 'node_modules/typescript')), 'Global consumer must not supply TypeScript');
  check(join(prefix, 'bin/flows'), globalProject);
  check(process.execPath, globalProject, [join(wrapper, 'bin/flows.js')]);
  resolvedInside(join(prefix, 'lib/node_modules/@relayflows/sdk/package.json'), prefix);
  console.log('CLI_PACKAGE_OK: local and global installs');
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
