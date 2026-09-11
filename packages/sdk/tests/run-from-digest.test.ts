import { afterEach, describe, expect, it, vi } from 'vitest';
import { once } from 'node:events';
import { readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Server } from 'node:net';
import { runCli } from '../src/cli.js';
import { fetchBundle, parseDigestReference } from '../src/bundle-transport.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { fixture } from './deploy-fixture.js';
import { sendOk, sendResult, startLoopback } from './journal-client-loopback.js';
const roots: string[] = [];
const servers: Server[] = [];
async function setup() {
  const f = await fixture(); roots.push(f.root);
  expect(f.invoke(['deploy', f.reference, '--to', f.bucket]).status).toBe(0);
  vi.stubEnv('XDG_CACHE_HOME', join(f.root, 'cache'));
  return f;
}
afterEach(async () => {
  vi.unstubAllEnvs(); vi.restoreAllMocks();
  for (const server of servers.splice(0)) await new Promise<void>(done => server.close(() => done()));
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
describe('flows run digest input', () => {
  it('submits the sealed canonical spec through the normal journal path without checkout', async () => {
    const f = await setup();
    const canonical = JSON.parse(await readFile(join(f.bundle, 'spec.canonical.json'), 'utf8'));
    await rm(join(f.root, 'dist'), { recursive: true }); await rm(join(f.root, 'hello.yaml'));
    const dataDir = join(f.root, 'data'); let submitted: unknown;
    const server = startLoopback(socketPathFor(dataDir), { hello: sendOk,
      'run.start': (ctx, params) => { submitted = params['spec']; sendResult(ctx, {
        run_id: 'digest-run', status: 'completed', completion_reason: 'success', completed_steps: 1,
      }); },
    });
    servers.push(server); if (!server.listening) await once(server, 'listening');
    const stdout: string[] = []; const stderr: string[] = [];
    const code = await runCli(['run', f.reference, '--bucket', f.bucket, '--data-dir', dataDir,
      '--no-spawn', '--no-observer-link', '--json'], { stdout: s => stdout.push(s), stderr: s => stderr.push(s) });
    expect(code, stderr.join('\n')).toBe(0); expect(submitted).toEqual(canonical);
    expect(JSON.parse(stdout.join('\n')).completionReason).toBe('success');
    expect(await readdir(join(f.root, 'cache/flows/bundles', f.digest))).toContain('identity.json');
  });
  it('uses a verified cache hit even after the bucket is removed', async () => {
    const f = await setup(); const ref = parseDigestReference(f.reference)!;
    const first = await fetchBundle(ref, f.bucket);
    await rm(join(f.root, 'bucket'), { recursive: true });
    expect(await fetchBundle(ref, f.bucket)).toBe(first);
    await writeFile(join(first, 'identity.json'), '{}');
    await expect(fetchBundle(ref, f.bucket)).rejects.toMatchObject({ kind: 'bundle_signature_invalid' });
  });
  it('resolves deploy.bucket from flows.json and honors explicit override', async () => {
    const f = await setup(); await writeFile(join(f.root, 'flows.json'), JSON.stringify({ deploy: { bucket: f.bucket } }));
    const args = ['run', f.reference, '--no-spawn', '--no-observer-link', '--data-dir', join(f.root, 'data')];
    const configured = f.invoke(args);
    expect(configured.status).toBe(2); expect(configured.stderr).toContain('daemon_unreachable');
    await rm(join(f.root, 'cache'), { recursive: true });
    const overridden = f.invoke([...args, '--bucket', 'file:///definitely-absent-flows-bucket']);
    expect(overridden.status).toBe(2); expect(overridden.stderr).toContain('bucket_unreachable');
  });
  it('refuses an unconfigured bucket', async () => {
    const f = await setup();
    const result = f.invoke(['run', f.reference, '--no-observer-link']);
    expect(result.status).toBe(2); expect(result.stderr).toContain('bucket_unconfigured');
  });
  it.each(['spec.canonical.json', 'identity.json'])('refuses tampered %s before creating run data', async file => {
    const f = await setup(); await writeFile(join(f.target, file), '{}');
    const data = join(f.root, 'data');
    const result = f.invoke(['run', f.reference, '--bucket', f.bucket, '--data-dir', data, '--no-observer-link']);
    expect(result.status).toBe(2); expect(result.stderr).toContain('bundle_signature_invalid');
    await expect(readdir(data)).rejects.toThrow();
  });
});
