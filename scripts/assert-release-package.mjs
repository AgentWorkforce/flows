import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [name, directory] = process.argv.slice(2);
assert(['surface', 'sdk', 'runtime-linux-x64'].includes(name), 'Unknown release package');
const source = JSON.parse(readFileSync(`packages/${name}/package.json`, 'utf8'));
const archive = join(directory, `relayflows-${name}-${source.version}.tgz`);
const entries = new Set(execFileSync('tar', ['-tzf', archive], { encoding: 'utf8' }).trim().split('\n'));
const pkg = JSON.parse(execFileSync('tar', ['-xOzf', archive, 'package/package.json'], { encoding: 'utf8' }));
assert.equal(pkg.name, `@relayflows/${name}`);
assert.equal(pkg.version, source.version);

const requireFile = (path) => {
  const entry = `package/${path.replace(/^\.\//, '')}`;
  assert(entries.has(entry), `Missing ${entry} in ${archive}`);
};
// Assert every advertised entrypoint, including declaration files and subpaths.
const walkExports = (value) => {
  if (typeof value === 'string') requireFile(value);
  else for (const child of Object.values(value || {})) walkExports(child);
};
if (name === 'runtime-linux-x64') {
  assert.deepEqual(pkg.os, ['linux']);
  assert.deepEqual(pkg.cpu, ['x64']);
  requireFile('bin/relayflowd');
  requireFile('bin/flows');
} else {
  assert.equal(pkg.main, './dist/index.js');
  requireFile('dist/index.js');
  requireFile(pkg.types);
  walkExports(pkg.exports);
}
for (const path of Object.values(pkg.bin || {})) requireFile(path);
for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
  for (const [dependency, version] of Object.entries(pkg[field] || {})) {
    assert(!/^(file:|link:|workspace:|\.{1,2}\/|\/)/.test(version), `Local dependency ${dependency}: ${version}`);
    if (['@relayflows/surface', '@relayflows/sdk', '@relayflows/runtime-linux-x64'].includes(dependency)) {
      assert.equal(version, pkg.version, `Internal dependency ${dependency} must use release version`);
    }
  }
}
if (name === 'sdk') assert.equal(pkg.dependencies['@relayflows/surface'], pkg.version);
console.log(`PACKED_CONTENTS_OK ${pkg.name}@${pkg.version}`);
