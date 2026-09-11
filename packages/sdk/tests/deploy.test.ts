import { afterEach, describe, expect, it, vi } from 'vitest';
import { chmod, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sha256, verifyBundle, type BundleEntry } from '../src/bundle.js';
import { buildFlow } from '../src/cli/build.js';
import { basename } from 'node:path';
import { fixture } from './deploy-fixture.js';
import * as transport from '../src/bundle-transport.js';
import { runDeploy } from '../src/cli/deploy.js';

const roots: string[] = [];
async function setup() { const f = await fixture(); roots.push(f.root); return f; }
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('flows deploy file buckets', () => {
  it('publishes the full signed layout byte-for-byte and redeploys as a noop', async () => {
    const f = await setup();
    const result = f.invoke(['deploy', f.reference, '--to', f.bucket]);
    expect(result.status, result.stderr).toBe(0);
    expect(await verifyBundle(f.target, f.digest)).toBe(f.digest);
    const entries = JSON.parse(await readFile(join(f.target, 'manifest.json'), 'utf8')) as BundleEntry[];
    for (const entry of entries) expect(sha256(await readFile(join(f.target, entry.path)))).toBe(entry.sha256);
    for (const file of await readdir(f.bundle)) expect(await readFile(join(f.target, file))).toEqual(await readFile(join(f.bundle, file)));
    const second = f.invoke(['deploy', '--to', f.bucket, f.reference]);
    expect(second.status).toBe(0); expect(second.stderr).toContain('deploy_noop');
    expect(second.stdout).toContain('SKIPPED (already-present)');
    expect(second.stdout).not.toContain('DEPLOYED');
  });
  it('reports already-present when another writer publishes during the copy', async () => {
    const f = await setup();
    vi.spyOn(process, 'cwd').mockReturnValue(f.root);
    const copy = transport.copyBundle;
    vi.spyOn(transport, 'copyBundle').mockImplementationOnce(async (source, target, digest) => {
      await copy(source, target, digest);
      return copy(source, target, digest);
    });
    const stdout: string[] = []; const stderr: string[] = [];
    expect(await runDeploy({ command: 'deploy', value: f.reference, to: f.bucket }, {
      stdout: line => stdout.push(line), stderr: line => stderr.push(line),
    })).toBe(0);
    expect(await verifyBundle(f.target, f.digest)).toBe(f.digest);
    expect(stdout.join('\n')).toContain('SKIPPED (already-present)');
    expect(stdout.join('\n')).not.toContain('DEPLOYED');
    expect(stderr.join('\n')).toContain('deploy_noop');
  });
  it('refuses a missing local bundle before creating the bucket', async () => {
    const f = await setup();
    await rm(f.bundle, { recursive: true });
    const result = f.invoke(['deploy', f.reference, '--to', f.bucket]);
    expect(result.status).toBe(2); expect(result.stderr).toContain('bundle_missing_locally');
    await expect(readdir(f.target)).rejects.toThrow();
  });
  it('refuses an unreachable bucket before copying', async () => {
    const f = await setup();
    const result = f.invoke(['deploy', f.reference, '--to', pathToFileURL(join(f.root, 'hello.yaml')).href]);
    expect(result.status).toBe(2); expect(result.stderr).toContain('bucket_unreachable');
  });
  it.skipIf(process.getuid?.() === 0)('refuses an unwritable bucket', async () => {
    const f = await setup();
    await chmod(f.root, 0o555);
    try {
      const result = f.invoke(['deploy', f.reference, '--to', f.bucket]);
      expect(result.status).toBe(2); expect(result.stderr).toContain('bucket_unreachable');
    } finally { await chmod(f.root, 0o755); }
  });
  it.each(['spec.canonical.json', 'identity.json'])('refuses local tampering of %s', async file => {
    const f = await setup(); await writeFile(join(f.bundle, file), '{}');
    const result = f.invoke(['deploy', f.reference, '--to', f.bucket]);
    expect(result.status).toBe(2); expect(result.stderr).toContain('bundle_signature_invalid');
    await expect(readdir(f.target)).rejects.toThrow();
  });
  it('refuses asset bundles instead of using daemon-relative files', async () => {
    const f = await setup();
    await writeFile(join(f.root, 'script.sh'), '#!/bin/sh\necho bundled\n');
    await writeFile(join(f.root, 'asset.yaml'), 'version: 0.1.0\nname: asset\nsteps:\n  - id: run\n    type: deterministic\n    command: ./script.sh\n');
    const built = await buildFlow(join(f.root, 'asset.yaml'), join(f.root, 'dist/flows'), () => {});
    const result = f.invoke(['deploy', basename(built), '--to', f.bucket]);
    expect(result.status).toBe(2); expect(result.stderr).toContain('bundle_unsupported');
  });
  it('never labels a corrupt existing deployment as a noop', async () => {
    const f = await setup(); expect(f.invoke(['deploy', f.reference, '--to', f.bucket]).status).toBe(0);
    await writeFile(join(f.target, 'identity.json'), '{}');
    const result = f.invoke(['deploy', f.reference, '--to', f.bucket]);
    expect(result.status).toBe(2); expect(result.stderr).toContain('bundle_signature_invalid');
    expect(result.stderr).not.toContain('deploy_noop');
  });
});
