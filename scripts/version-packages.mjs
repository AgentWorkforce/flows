import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const paths = ['surface', 'sdk', 'runtime-linux-x64'].map((name) => `packages/${name}/package.json`);
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const names = new Set(paths.map((path) => read(path).name));
const bump = process.env.CUSTOM_VERSION || process.env.VERSION_TYPE || 'patch';
if (bump.startsWith('-')) throw new Error('Version cannot be an npm option');

// The SDK is the one release anchor. npm validates semver and performs all
// seven supported bumps; package-lock=false leaves the development lock alone.
execFileSync('npm', ['version', bump, '--no-git-tag-version', '--allow-same-version',
  '--ignore-scripts', '--package-lock=false', `--preid=${process.env.PREID || 'beta'}`],
{ cwd: 'packages/sdk', stdio: 'inherit' });
const version = read('packages/sdk/package.json').version;
if (version.includes('-') && process.env.DIST_TAG === 'latest') {
  throw new Error('Prereleases require a non-latest dist-tag');
}
for (const path of paths) {
  const pkg = read(path);
  pkg.version = version;
  for (const field of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[field] || {})) {
      if (names.has(name)) pkg[field][name] = version;
    }
  }
  writeFileSync(path, `${JSON.stringify(pkg, null, 2)}\n`);
  console.log(`${pkg.name} -> ${version}`);
}
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `new_version=${version}\n`);
