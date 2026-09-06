import { readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

// The SDK is the version anchor; no package independently computes a bump.
const paths = ['surface', 'sdk', 'runtime-linux-x64'].map((name) => `packages/${name}/package.json`);
if (process.env.CUSTOM_VERSION && !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(process.env.CUSTOM_VERSION)) {
  throw new Error('custom_version must be a semantic version');
}
const versionArgs = process.env.CUSTOM_VERSION
  ? [process.env.CUSTOM_VERSION, '--allow-same-version']
  : [process.env.VERSION_TYPE || 'patch', `--preid=${process.env.PREID || 'beta'}`];
execFileSync('npm', ['version', ...versionArgs, '--no-git-tag-version', '--ignore-scripts', '--package-lock=false'], {
  cwd: 'packages/sdk', stdio: 'inherit',
});
const read = (path) => JSON.parse(readFileSync(path, 'utf8'));
const version = read('packages/sdk/package.json').version;
const names = new Set(paths.map((path) => read(path).name));
for (const path of paths) {
  const pkg = read(path);
  pkg.version = version;
  for (const type of ['dependencies', 'devDependencies', 'optionalDependencies', 'peerDependencies']) {
    for (const name of Object.keys(pkg[type] || {})) {
      if (names.has(name)) pkg[type][name] = version;
    }
  }
  writeFileSync(path, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`${pkg.name} -> ${version}`);
}
if (process.env.GITHUB_OUTPUT) {
  writeFileSync(process.env.GITHUB_OUTPUT,
    `new_version=${version}\nis_prerelease=${version.includes('-')}\n`, { flag: 'a' });
}
