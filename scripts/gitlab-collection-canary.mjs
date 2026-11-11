#!/usr/bin/env node
// Exercise a supplied standalone CLI and daemon, including its embedded helper
// transport. Synthetic local mount only; this is not hosted/customer proof.
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { access, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { promisify } from 'node:util';

const options = process.argv.slice(2);
assert.equal(options.length, 6, 'usage: gitlab-collection-canary.mjs --flows <standalone-binary> --relayflowd <daemon-binary> <--surface-version exact-published-version|--surface-tarball candidate.tgz>');
assert.equal(options[0], '--flows');
assert.equal(options[2], '--relayflowd');
assert.ok(['--surface-version', '--surface-tarball'].includes(options[4]));
const published = options[4] === '--surface-version';
if (published) assert.match(options[5], /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
const surfaceInput = published ? `@relayflows/surface@${options[5]}` : resolve(options[5]);
const tarballSha256 = published ? undefined : createHash('sha256').update(await readFile(surfaceInput)).digest('hex');
const flows = resolve(options[1]);
const relayflowd = resolve(options[3]);
await Promise.all([access(flows), access(relayflowd)]);
const directory = await realpath(await mkdtemp(join(tmpdir(), 'flows-gitlab-canary-')));
const mount = join(directory, 'mount');
const data = join(directory, 'journal');
const projectPath = 'canary/subgroup/project';
const prefix = `/gitlab/projects/${projectPath}`;
const issues = Array.from({ length: 8 }, (_, index) => ({ iid: index + 1, title: `issue ${index + 1}`, state: index === 7 ? 'closed' : 'opened' }));
const requests = [{ iid: 9, title: 'merged request', state: 'merged' }];
const fixtures = {
  ...Object.fromEntries(issues.map(issue => [`${prefix}/issues/${issue.iid}__issue/meta.json`, issue])),
  [`${prefix}/merge_requests/9__request/meta.json`]: requests[0],
  [`${prefix}/issues/_index.json`]: issues.map(({ iid }) => ({ iid })),
  [`${prefix}/merge_requests/_index.json`]: [{ iid: 9 }],
  [`${prefix}/issues/1__issue/comments/1.json`]: { iid: 'child' },
  [`${prefix}/issues/1__issue/children/meta.json`]: { iid: 'grandchild' },
  [`${prefix}/issues/by-id/1.json`]: { iid: 'alias' },
  [`${prefix}/issues/by-id/1/meta.json`]: { iid: 'directory-alias' },
  '/gitlab/projects/canary/foreign/issues/1__other/meta.json': { iid: 'foreign-project' },
};
const env = {
  PATH: process.env.PATH ?? '', HOME: directory, TMPDIR: tmpdir(),
  FLOWS_AUTHORED_NODE: process.execPath,
  RELAYFILE_MOUNT_PATH: mount,
  RELAYFLOWS_GITLAB_MOCK: '0', FLOWS_CLOUD_MIRROR: '0',
};
let daemon;
let daemonError = '';
try {
  await writeFile(join(directory, 'package.json'), JSON.stringify({ private: true, type: 'module' }));
  // Install the exact registry release or explicitly labelled candidate pack
  // beside the authored source, with no workspace links or parent fallback.
  await promisify(execFile)('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund', '--omit=dev',
    '--registry=https://registry.npmjs.org', '--save-exact', surfaceInput], { cwd: directory, env, timeout: 120_000 });
  const surfaceRoot = join(directory, 'node_modules/@relayflows/surface');
  assert.equal(await realpath(surfaceRoot), surfaceRoot, 'Surface must be a physical registry installation');
  const manifestBytes = await readFile(join(surfaceRoot, 'package.json'));
  const surface = JSON.parse(manifestBytes);
  assert.equal(surface.name, '@relayflows/surface');
  if (published) assert.equal(surface.version, options[5]);
  const require = createRequire(join(directory, 'package.json'));
  assert.equal(await realpath(require.resolve('@relayflows/surface')), join(surfaceRoot, 'dist/index.js'));
  const runtime = require.resolve('@relayflows/surface/runtime');
  assert.equal(await realpath(runtime), join(surfaceRoot, 'dist/runtime.js'));
  assert.equal(await realpath(join(surfaceRoot, surface.exports['.'].types)), join(surfaceRoot, 'dist/index.d.ts'));
  const helpersRoot = join(directory, 'node_modules/@relayfile/relay-helpers');
  assert.equal(await realpath(helpersRoot), helpersRoot);
  const helpers = JSON.parse(await readFile(join(helpersRoot, 'package.json'), 'utf8'));
  assert.equal(helpers.version, surface.peerDependencies['@relayfile/relay-helpers']);
  const runtimeSha256 = createHash('sha256').update(await readFile(runtime)).digest('hex');
  const manifestSha256 = createHash('sha256').update(manifestBytes).digest('hex');
  const lock = JSON.parse(await readFile(join(directory, 'package-lock.json'), 'utf8'));
  const packageIntegrity = lock.packages['node_modules/@relayflows/surface'].integrity;
  assert.match(packageIntegrity, /^sha512-/);
  for (const [path, value] of Object.entries(fixtures)) {
    const target = join(mount, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify(value));
  }
  await symlink('1__issue', join(mount, prefix, 'issues', 'linked-record'));
  const flow = join(directory, 'gitlab-collection-canary.flow.ts');
  await writeFile(flow, `import { flow } from '@relayflows/surface';
import { deepStrictEqual } from 'node:assert/strict';
export default flow('gitlab-collection-canary', { tools: { gitlab: true } }, async f => {
  const issues = await f.gitlab.issues.list({ projectPath: ${JSON.stringify(projectPath)} });
  const requests = await f.gitlab['merge-requests'].list({ projectPath: ${JSON.stringify(projectPath)} });
  deepStrictEqual(issues, ${JSON.stringify(issues)}, 'GitLab issue collection mismatch');
  deepStrictEqual(requests, ${JSON.stringify(requests)}, 'GitLab MR collection mismatch');
  f.done('success');
});
`);
  daemon = spawn(relayflowd, ['--data-dir', data, 'serve'], { env, stdio: ['ignore', 'ignore', 'pipe'] });
  daemon.stderr.on('data', chunk => { daemonError += chunk; });
  const daemonStarted = new Promise((_, reject) => daemon.once('error', reject));
  // The file is only a boot hint. The CLI must then perform its real handshake
  // and run both journaled helper reads before this script reports success.
  await Promise.race([daemonStarted, (async () => {
    for (let attempt = 0; attempt < 250; attempt++) {
      if (daemon.exitCode !== null) throw new Error(`canary daemon exited: ${daemonError}`);
      try { await access(join(data, 'connection.json')); return; } catch {}
      await new Promise(resolveWait => setTimeout(resolveWait, 20));
    }
    throw new Error(`canary daemon did not start: ${daemonError}`);
  })()]);
  const args = ['run', '--json', '--no-spawn', '--no-observer-link', '--data-dir', data, flow, '--input', '{}'];
  const { stdout, stderr } = await promisify(execFile)(flows, args, { env, cwd: directory, timeout: 90_000, maxBuffer: 4 * 1024 * 1024 });
  const report = JSON.parse(stdout);
  assert.equal(report.ok, true, stdout + stderr);
  assert.equal(report.path, flow, stdout + stderr);
  assert.equal(report.completionReason, 'success', stdout + stderr);
  assert.equal(typeof report.runId, 'string');
  const sha256 = createHash('sha256').update(await readFile(flows)).digest('hex');
  const daemonSha256 = createHash('sha256').update(await readFile(relayflowd)).digest('hex');
  console.log(JSON.stringify({ proof: 'standalone-cli-synthetic-gitlab-collections', sha256,
    daemonSha256, artifactSource: published ? 'registry' : 'candidate-tarball',
    surface: { tarballSha256, packageIntegrity, manifestSha256,
      version: surface.version, runtimeSha256, helpersVersion: helpers.version }, issues: 8, mergeRequests: 1, report }));
} finally {
  if (daemon?.pid && daemon.exitCode === null && daemon.signalCode === null) {
    const exited = once(daemon, 'exit');
    daemon.kill('SIGTERM');
    let timer;
    try {
      const stopped = await Promise.race([exited.then(() => true), new Promise(resolveWait => { timer = setTimeout(() => resolveWait(false), 2_000); })]);
      if (!stopped) { daemon.kill('SIGKILL'); await exited; }
    } finally { clearTimeout(timer); }
  }
  await rm(directory, { recursive: true, force: true });
}
