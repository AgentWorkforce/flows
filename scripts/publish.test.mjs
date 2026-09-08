import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const versionScript = resolve('scripts/version-packages.mjs');
const packScript = resolve('scripts/pack-release.mjs');
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'flows-publish-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of ['surface', 'sdk', 'runtime-linux-x64', 'runtime-darwin-arm64', 'relayflows']) {
    mkdirSync(join(root, 'packages', name), { recursive: true });
    const path = join(root, 'packages', name, 'package.json');
    cpSync(`packages/${name}/package.json`, path);
    const pkg = read(path);
    pkg.version = '2.0.0';
    // Drop packaging lifecycle scripts. The fixture exists to exercise
    // pack-release's OWN assertions, and `npm pack --ignore-scripts` was still
    // running `prepare` -> `bun run build` -> `tsc` on a CI runner, so npm
    // failed before the script could report `missing package/dist/index.js`.
    // It passed locally only because this machine happened to have the
    // toolchain the fixture does not install.
    for (const hook of ['prepare', 'prepack', 'postpack', 'prepublishOnly']) {
      delete pkg.scripts?.[hook];
    }
    writeFileSync(path, JSON.stringify(pkg));
  }
  return root;
}
function version(root, env) {
  return spawnSync(process.execPath, [versionScript], {
    cwd: root, encoding: 'utf8', env: { ...process.env, CUSTOM_VERSION: '', ...env },
  });
}

test('one SDK anchor rewrites all internal dependency types and preserves external ranges', (t) => {
  const root = fixture(t);
  const path = join(root, 'packages/sdk/package.json');
  const pkg = read(path);
  pkg.dependencies['@relayflows/surface'] = 'file:../surface';
  pkg.optionalDependencies = { '@relayflows/runtime-linux-x64': '^1.0.0' };
  pkg.peerDependencies = { '@relayflows/surface': '^1.0.0' };
  pkg.devDependencies['@relayflows/surface'] = 'workspace:*';
  writeFileSync(path, JSON.stringify(pkg));
  const result = version(root, { CUSTOM_VERSION: '3.0.0-rc.2' });
  assert.equal(result.status, 0, result.stderr);
  for (const name of ['sdk', 'surface', 'runtime-linux-x64', 'runtime-darwin-arm64', 'relayflows']) {
    assert.equal(read(join(root, 'packages', name, 'package.json')).version, '3.0.0-rc.2');
  }
  const updated = read(path);
  for (const type of ['dependencies', 'devDependencies', 'peerDependencies']) {
    assert.equal(updated[type]['@relayflows/surface'], '3.0.0-rc.2');
  }
  assert.equal(updated.optionalDependencies['@relayflows/runtime-linux-x64'], '3.0.0-rc.2');
  assert.equal(updated.dependencies.yaml, pkg.dependencies.yaml);
  const relayflows = read(join(root, 'packages/relayflows/package.json'));
  assert.equal(relayflows.dependencies['@relayflows/sdk'], '3.0.0-rc.2');
  // relayflows' real optionalDependencies (not the synthetic sdk one set up
  // above) — both per-platform runtime packages must move together with it.
  assert.equal(relayflows.optionalDependencies['@relayflows/runtime-linux-x64'], '3.0.0-rc.2');
  assert.equal(relayflows.optionalDependencies['@relayflows/runtime-darwin-arm64'], '3.0.0-rc.2');
});

test('prerelease bumps use the SDK anchor and output the resolved version', (t) => {
  const root = fixture(t);
  const output = join(root, 'output');
  const result = version(root, { VERSION_TYPE: 'preminor', PREID: 'beta', GITHUB_OUTPUT: output });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(read(join(root, 'packages/sdk/package.json')).version, '2.1.0-beta.0');
  assert.equal(readFileSync(output, 'utf8'), 'new_version=2.1.0-beta.0\nis_prerelease=true\n');
});

test('invalid custom versions fail before any package changes', (t) => {
  const root = fixture(t);
  for (const value of ['invalid', '--help', '2.0.1; echo injected']) {
    const result = version(root, { CUSTOM_VERSION: value });
    assert.notEqual(result.status, 0);
    assert.equal(read(join(root, 'packages/sdk/package.json')).version, '2.0.0');
  }
});

test('actual npm tarballs reject missing dist and local dependencies, then accept built surface', (t) => {
  const root = fixture(t);
  const run = () => spawnSync(process.execPath, [packScript, 'surface'], { cwd: root, encoding: 'utf8' });
  const missing = run();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /missing package\/dist\/index.js/);
  const dist = join(root, 'packages/surface/dist');
  mkdirSync(dist);
  for (const file of ['index.js', 'index.d.ts', 'runtime.js', 'runtime.d.ts']) {
    writeFileSync(join(dist, file), 'export {};\n');
  }
  const path = join(root, 'packages/surface/package.json');
  const pkg = read(path);
  pkg.dependencies = { external: 'file:../external' };
  writeFileSync(path, JSON.stringify(pkg));
  const local = run();
  assert.notEqual(local.status, 0);
  assert.match(local.stderr, /local dependency external/);
  delete pkg.dependencies;
  writeFileSync(path, JSON.stringify(pkg));
  const built = run();
  assert.equal(built.status, 0, built.stderr);
  assert.match(built.stdout, /PACK_OK @relayflows\/surface@2.0.0/);
});

test('relayflows tarball publishes unscoped and rejects a missing bin', (t) => {
  const root = fixture(t);
  // fixture() pins every package to '2.0.0' independently; align relayflows's
  // committed dependency pin the way version-packages.mjs would for a real
  // release, so this test exercises the bin/executable checks, not the
  // (separately real) local-dependency-drift assertion.
  const path = join(root, 'packages/relayflows/package.json');
  const pkg = read(path);
  pkg.dependencies['@relayflows/sdk'] = '2.0.0';
  for (const name of Object.keys(pkg.optionalDependencies || {})) {
    pkg.optionalDependencies[name] = '2.0.0';
  }
  writeFileSync(path, JSON.stringify(pkg));
  const run = () => spawnSync(process.execPath, [packScript, 'relayflows'], { cwd: root, encoding: 'utf8' });
  const missing = run();
  assert.notEqual(missing.status, 0);
  assert.match(missing.stderr, /missing package\/bin\/flows.js/);
  const bin = join(root, 'packages/relayflows/bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'flows.js'), '#!/usr/bin/env node\n');
  const built = run();
  // Not yet executable: same failure pack-release.mjs gives for surface/sdk/runtime.
  assert.notEqual(built.status, 0);
  assert.match(built.stderr, /non-executable \.\/bin\/flows\.js/);
  execFileSync('chmod', ['+x', join(bin, 'flows.js')]);
  const executable = run();
  assert.equal(executable.status, 0, executable.stderr);
  // Unscoped — not `@relayflows/relayflows`, unlike every other release package.
  assert.match(executable.stdout, /PACK_OK relayflows@2.0.0/);
});

test('runtime tarball refuses an unstaged binary package', (t) => {
  const root = fixture(t);
  for (const name of ['runtime-linux-x64', 'runtime-darwin-arm64']) {
    const result = spawnSync(process.execPath, [packScript, name], {
      cwd: root, encoding: 'utf8',
    });
    assert.notEqual(result.status, 0, name);
    assert.match(result.stderr, /missing package\/bin\/relayflowd/, name);
  }
});

test('a runtime tarball packs and asserts shape, running the real smoke only on a matching host', (t) => {
  const root = fixture(t);
  const bin = join(root, 'packages/runtime-darwin-arm64/bin');
  mkdirSync(bin);
  // Not a real Mach-O binary, but scriptable enough to behave correctly IF
  // this test happens to run on an actual darwin-arm64 host (pack-release.mjs
  // only skips execution on a *foreign* host — same-host still runs it for
  // real, which this repo's own dev machines can be).
  const stub = ['#!/bin/sh', 'if [ "$1" = "--help" ]; then exit 0; fi',
    'if [ "$1" = "check" ]; then echo \'{"ok":true,"path":"testdata/hello-deterministic.flow.yaml"}\'; exit 0; fi',
    'exit 1', ''].join('\n');
  writeFileSync(join(bin, 'relayflowd'), stub);
  writeFileSync(join(bin, 'flows'), stub);
  execFileSync('chmod', ['+x', join(bin, 'relayflowd'), join(bin, 'flows')]);
  const result = spawnSync(process.execPath, [packScript, 'runtime-darwin-arm64'], {
    cwd: root, encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /PACK_OK @relayflows\/runtime-darwin-arm64@2\.0\.0/);
  const isMatchingHost = process.platform === 'darwin' && process.arch === 'arm64';
  assert.equal(result.stdout.includes('Skipping runtime-darwin-arm64 execution smoke'), !isMatchingHost);
});
