import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, readdir, writeFile, rm, mkdir, symlink, stat, chmod, rename } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { canonicalize } from '../src/canonical.js';
import { sealBundle, sha256, verifyBundle } from '../src/bundle.js';
import { buildFlow } from '../src/cli/build.js';

const sdk = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(sdk, '../..');
const cli = join(sdk, 'dist/cli.js');
const temporary: string[] = [];
const key = Buffer.alloc(32, 7).toString('base64');
async function temp() {
  const path = await mkdtemp(join(tmpdir(), 'flows-bundle-test-'));
  temporary.push(path);
  return path;
}
function invoke(args: string[], cwd = repo, env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [cli, 'build', ...args], {
    cwd, encoding: 'utf8', timeout: 120_000,
    env: { PATH: process.env['PATH'], FLOWS_BUILD_KEY: key, ...env },
  });
}
async function seal(out: string, env: NodeJS.ProcessEnv = { FLOWS_BUILD_KEY: key }, warn = (_: string) => {}) {
  return sealBundle({ name: 'example', repo: out, out, env, warn, files: [
    { path: 'spec.canonical.json', data: canonicalize({ name: 'example' }) },
    { path: 'preflight.json', data: '{}' }, { path: 'lockfile.json', data: '{}' },
  ] });
}
afterEach(async () => { await Promise.all(temporary.splice(0).map(path => rm(path, { force: true, recursive: true }))); });

describe('immutable bundles', () => {
  it('is byte-for-byte deterministic with a stable identity and reuses existing bundles', async () => {
    const a = await seal(await temp());
    const b = await seal(await temp());
    expect(basename(a)).toBe(basename(b));
    for (const file of await readdir(a)) expect(await readFile(join(a, file))).toEqual(await readFile(join(b, file)));
    const manifest = await readFile(join(a, 'manifest.json'), 'utf8');
    expect(basename(a)).toBe(`example@sha256:${sha256(manifest)}`);
    const before = await stat(join(a, 'identity.json'));
    expect(await seal(dirname(a), {})).toBe(a);
    expect((await stat(join(a, 'identity.json'))).mtimeMs).toBe(before.mtimeMs);
  });

  it('keeps the payload digest deterministic with ephemeral signatures and warns', async () => {
    const warnings: string[] = [];
    const a = await seal(await temp(), {}, warning => warnings.push(warning));
    const b = await seal(await temp(), {});
    expect(warnings).toEqual(['identity_ephemeral: bundle can be verified but not attributed']);
    expect(basename(a)).toBe(basename(b));
    expect(await readFile(join(a, 'identity.json'))).not.toEqual(await readFile(join(b, 'identity.json')));
    expect(await verifyBundle(a)).toBe(await verifyBundle(b));
  });

  it('uses the local seed and lets the environment take precedence', async () => {
    const out = await temp();
    await mkdir(join(out, '.flows'));
    await writeFile(join(out, '.flows/build.key'), `${key}\n`);
    const local = await seal(out, {});
    const env = await seal(await temp());
    expect(await readFile(join(local, 'identity.json'))).toEqual(await readFile(join(env, 'identity.json')));
    await expect(seal(await temp(), { FLOWS_BUILD_KEY: 'invalid' })).rejects.toThrow('32-byte seed');
  });

  it('returns exit 2 naming a byte-flipped payload and refuses to reuse corruption', async () => {
    const out = await temp();
    const bundle = await seal(out);
    const path = join(bundle, 'spec.canonical.json');
    const bytes = await readFile(path); bytes[0] = bytes[0]! ^ 1; await writeFile(path, bytes);
    const result = invoke(['--verify', bundle]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('spec.canonical.json');
    await expect(seal(out)).rejects.toThrow('spec.canonical.json');
  });

  it.each(['identity.json', 'manifest.json'])('detects tampered %s', async file => {
    const bundle = await seal(await temp());
    await writeFile(join(bundle, file), '{}');
    await expect(verifyBundle(bundle)).rejects.toThrow(file);
  });

  it('rejects a renamed digest directory and a well-formed invalid signature', async () => {
    const out = await temp();
    const bundle = await seal(out);
    const moved = join(out, `example@sha256:${'0'.repeat(64)}`);
    await rename(bundle, moved);
    await expect(verifyBundle(moved)).rejects.toThrow('directory digest mismatch');
    await rename(moved, bundle);
    const identity = JSON.parse(await readFile(join(bundle, 'identity.json'), 'utf8'));
    identity.signature_hex = '0'.repeat(128);
    await writeFile(join(bundle, 'identity.json'), canonicalize(identity));
    await expect(verifyBundle(bundle)).rejects.toThrow('identity.json: signature mismatch');
  });

  it('rejects extra files, symlinks, and manifest traversal', async () => {
    const bundle = await seal(await temp());
    await writeFile(join(bundle, 'extra'), 'extra');
    await expect(verifyBundle(bundle)).rejects.toThrow('extra');
    await rm(join(bundle, 'extra'));
    await rm(join(bundle, 'lockfile.json'));
    await symlink(join(bundle, 'preflight.json'), join(bundle, 'lockfile.json'));
    await expect(verifyBundle(bundle)).rejects.toThrow('lockfile.json');
    await writeFile(join(bundle, 'manifest.json'), canonicalize([{ path: '../outside', sha256: 'a'.repeat(64), bytes: 0 }]));
    await expect(verifyBundle(bundle)).rejects.toThrow('manifest.json');
  });

  it('builds and verifies the canonical YAML fixture through the compiled CLI', async () => {
    const out = await temp();
    const result = invoke(['--out', out, 'testdata/hello-deterministic.flow.yaml']);
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
    const bundle = result.stdout.trim();
    expect(await readFile(join(bundle, 'spec.canonical.json'), 'utf8')).toBe(
      (await readFile(join(repo, 'testdata/hello-deterministic.spec.canonical.json'), 'utf8')).trim(),
    );
    expect(await readdir(bundle)).not.toContain('flow');
    expect(invoke(['--verify', bundle]).status).toBe(0);
    expect(invoke(['--out', out, 'testdata/hello-deterministic.flow.yaml']).stdout).toBe(result.stdout);
  });

  it('emits the ephemeral warning on CLI stderr and uses the default output directory', async () => {
    const cwd = await temp();
    await writeFile(join(cwd, 'hello.yaml'), await readFile(join(repo, 'testdata/hello-deterministic.flow.yaml')));
    const result = invoke(['hello.yaml'], cwd, { FLOWS_BUILD_KEY: undefined });
    expect(result.status).toBe(0);
    expect(result.stderr).toContain('identity_ephemeral: bundle can be verified but not attributed');
    expect(result.stdout).toContain(join(cwd, 'dist/flows'));
    expect(invoke(['--verify', result.stdout.trim()]).status).toBe(0);
  });

  it('captures relative file references and refuses missing assets', async () => {
    const cwd = await temp();
    await writeFile(join(cwd, 'script.sh'), '#!/bin/sh\necho hello\n');
    await writeFile(join(cwd, 'hello.yaml'), 'version: 0.1.0\nname: asset-flow\nsteps:\n  - id: run\n    type: deterministic\n    command: ./script.sh\n');
    const bundle = await buildFlow(join(cwd, 'hello.yaml'), join(cwd, 'out'), () => {});
    expect(await readFile(join(bundle, 'assets/script.sh'), 'utf8')).toContain('echo hello');
    expect(await readFile(join(bundle, 'spec.canonical.json'), 'utf8')).toContain('./assets/script.sh');
    await rm(join(cwd, 'script.sh'));
    await expect(buildFlow(join(cwd, 'hello.yaml'), join(cwd, 'out'), () => {})).rejects.toThrow('script.sh');
  });

  it('preserves quoted asset words and executable permissions', async () => {
    const cwd = await temp();
    await writeFile(join(cwd, 'run script.sh'), '#!/bin/sh\ncat "$1"\n');
    await chmod(join(cwd, 'run script.sh'), 0o755);
    await writeFile(join(cwd, 'data.txt'), 'bundled asset\n');
    await writeFile(join(cwd, 'hello.yaml'), JSON.stringify({ version: '0.1.0', name: 'assets', steps: [
      { id: 'run', type: 'deterministic', command: '"./run script.sh" ./data.txt' },
    ] }));
    const bundle = await buildFlow(join(cwd, 'hello.yaml'), join(cwd, 'out'), () => {});
    const spec = JSON.parse(await readFile(join(bundle, 'spec.canonical.json'), 'utf8'));
    expect(spec.steps[0].command).toBe('"./assets/run script.sh" ./assets/data.txt');
    const result = spawnSync('/bin/sh', ['-c', spec.steps[0].command], { cwd: bundle, encoding: 'utf8' });
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('bundled asset\n');
    expect(JSON.parse(await readFile(join(bundle, 'metadata.json'), 'utf8')).executables).toEqual(['assets/run script.sh']);
    expect(await verifyBundle(bundle)).toBe(basename(bundle).split('@sha256:')[1]);
  });

  it('refuses build-provable CLI resolution errors without environment probes', async () => {
    const cwd = await temp();
    await writeFile(join(cwd, 'invalid.yaml'), JSON.stringify({ version: '0.1.0', name: 'invalid', steps: [
      { id: 'ask', type: 'agent', instruction: 'hello' },
    ] }));
    const result = invoke(['invalid.yaml'], cwd);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('cli_unresolved');
  });

  it('builds a standalone TS fixture twice with identical executable hashes', async () => {
    const result = invoke(['--out', await temp(), 'packages/sdk/tests/fixtures/build.flow.ts']);
    expect(result.stderr).toBe(''); expect(result.status).toBe(0);
    const bundle = result.stdout.trim();
    const second = invoke(['--out', await temp(), 'packages/sdk/tests/fixtures/build.flow.ts']);
    expect(second.status).toBe(0); expect(basename(second.stdout.trim())).toBe(basename(bundle));
    for (const file of await readdir(bundle)) expect(sha256(await readFile(join(bundle, file)))).toBe(sha256(await readFile(join(second.stdout.trim(), file))));
    expect((await stat(join(bundle, 'flow'))).mode & 0o111).not.toBe(0);
    expect(invoke(['--verify', bundle]).status).toBe(0);
    expect(JSON.parse(await readFile(join(bundle, 'metadata.json'), 'utf8')).platform).toEqual({ os: process.platform, arch: process.arch });
  }, 120_000);

  it('refuses to label installed dependency drift with lockfile pins', async () => {
    const cwd = await temp();
    await writeFile(join(cwd, 'hello.ts'), 'export default {};');
    await mkdir(join(cwd, 'node_modules/example'), { recursive: true });
    await writeFile(join(cwd, 'node_modules/example/package.json'), JSON.stringify({ version: '2.0.0' }));
    await writeFile(join(cwd, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages: {
      'node_modules/example': { version: '1.0.0' },
    } }));
    const result = invoke(['hello.ts'], cwd);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain('node_modules/example does not match its pinned version');
  });

  it.each([[], ['--out'], ['--verify'], ['--verify', 'x', 'y'], ['--out', 'x', '--out', 'y', 'flow.yaml']])('refuses invalid CLI arguments %j', async (...args) => {
    expect(invoke(args).status).toBe(2);
  });
});
