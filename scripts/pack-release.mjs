import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const [name, output = 'dist/publish'] = process.argv.slice(2);
const runtimeMatch = /^runtime-([a-z0-9]+)-([a-z0-9]+)$/.exec(name ?? '');
assert(
  ['surface', 'sdk', 'relayflows'].includes(name) || runtimeMatch !== null,
  'unknown release package',
);
// Every release package is scoped (@relayflows/<name>) except the CLI alias,
// which is published unscoped so `npm install -g relayflows` names it directly.
const expectedName = name === 'relayflows' ? 'relayflows' : `@relayflows/${name}`;
const directory = resolve(`packages/${name}`);
const destination = resolve(output);
mkdirSync(destination, { recursive: true });
const [packed] = JSON.parse(execFileSync('npm', [
  'pack', '--ignore-scripts', '--json', '--pack-destination', destination,
], { cwd: directory, encoding: 'utf8' }));
const archive = join(destination, packed.filename);
const unpacked = mkdtempSync(join(tmpdir(), 'flows-release-'));
try {
  execFileSync('tar', ['-xzf', archive, '-C', unpacked]);
  const root = join(unpacked, 'package');
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  assert.equal(pkg.name, expectedName);
  const expected = JSON.parse(readFileSync('packages/sdk/package.json', 'utf8')).version;
  assert.equal(pkg.version, expected, 'package version differs from SDK anchor');
  for (const type of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const [dependency, version] of Object.entries(pkg[type] || {})) {
      assert(!/^(file:|link:|workspace:)/.test(version), `local dependency ${dependency}`);
      if (dependency.startsWith('@relayflows/')) assert.equal(version, expected);
    }
  }
  const required = runtimeMatch !== null
    ? ['bin/relayflowd', 'bin/flows']
    : name === 'relayflows'
      ? ['bin/flows.js']
      : ['dist/index.js', 'dist/index.d.ts'];
  if (name === 'surface') required.push('dist/runtime.js', 'dist/runtime.d.ts');
  if (name === 'sdk') required.push('dist/cli.js');
  for (const file of required) {
    assert(packed.files.some((entry) => entry.path === file), `missing package/${file}`);
    assert(existsSync(join(root, file)), `missing unpacked package/${file}`);
    assert(statSync(join(root, file)).size > 0, `empty package/${file}`);
  }
  for (const file of Object.values(pkg.bin || {})) {
    assert(statSync(join(root, file)).mode & 0o111, `non-executable ${file}`);
  }
  if (runtimeMatch !== null) {
    const [, platform, arch] = runtimeMatch;
    // A cross-arch repack (e.g. re-verifying runtime-darwin-arm64's tarball
    // from the linux publish job) can only assert shape, above — a foreign
    // binary cannot be executed here. Only the matching host actually runs
    // it, which is also where CI originally built and smoke-tested it.
    if (process.platform === platform && process.arch === arch) {
      execFileSync(join(root, 'bin/relayflowd'), ['--help'], { stdio: 'inherit' });
      const report = JSON.parse(execFileSync(join(root, 'bin/flows'), [
        'check', '--json', 'testdata/hello-deterministic.flow.yaml',
      ], { encoding: 'utf8' }));
      assert.equal(report.ok, true);
      assert.equal(report.path, 'testdata/hello-deterministic.flow.yaml');
    } else {
      console.log(`Skipping ${name} execution smoke: built for ${platform}-${arch}, running on ${process.platform}-${process.arch}`);
    }
  }
  console.log(`PACK_OK ${pkg.name}@${pkg.version}: ${required.map((file) => `package/${file}`).join(', ')}`);
  if (process.env.GITHUB_OUTPUT) {
    const { appendFileSync } = await import('node:fs');
    appendFileSync(process.env.GITHUB_OUTPUT, `tarball=${archive}\n`);
  }
} finally {
  rmSync(unpacked, { recursive: true, force: true });
}
