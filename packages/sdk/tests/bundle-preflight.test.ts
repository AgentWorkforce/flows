import { afterEach, describe, expect, it, vi } from 'vitest';
import { rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { buildFlow } from '../src/cli/build.js';
import { checkRunnableBundle } from '../src/cli/bundle-preflight.js';
import { fetchBundle, parseDigestReference } from '../src/bundle-transport.js';
import { fixture } from './deploy-fixture.js';

const roots: string[] = [];
async function setup() { const f = await fixture(); roots.push(f.root); return f; }
afterEach(async () => {
  vi.unstubAllEnvs();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('bundle execution preflight', () => {
  it('ignores surrounding cache configuration on a verified cache hit', async () => {
    const f = await setup();
    expect(f.invoke(['deploy', f.reference, '--to', f.bucket]).status).toBe(0);
    vi.stubEnv('XDG_CACHE_HOME', join(f.root, 'cache'));
    const ref = parseDigestReference(f.reference)!;
    const cache = await fetchBundle(ref, f.bucket);
    const before = await checkRunnableBundle(cache, ref.name);
    expect(before.report.ok).toBe(true);
    await writeFile(join(dirname(cache), 'flows.json'), '{invalid cache config');
    expect(await fetchBundle(ref, f.bucket)).toBe(cache);
    expect(await checkRunnableBundle(cache, ref.name)).toEqual(before);
  });

  it('uses the built alias for a nameless flow even in a digest-only cache directory', async () => {
    const f = await setup();
    await writeFile(join(f.root, 'nameless.yaml'), 'version: 0.1.0\nsteps:\n  - id: greet\n    type: deterministic\n    command: echo nameless\n');
    const bundle = await buildFlow(join(f.root, 'nameless.yaml'), join(f.root, 'dist/flows'), () => {});
    const reference = basename(bundle);
    expect(reference).toMatch(/^flow@sha256:/);
    expect(f.invoke(['deploy', reference, '--to', f.bucket]).status).toBe(0);
    vi.stubEnv('XDG_CACHE_HOME', join(f.root, 'cache'));
    const ref = parseDigestReference(reference)!;
    const cache = await fetchBundle(ref, f.bucket);
    expect(basename(cache)).toBe(ref.digest);
    const checked = await checkRunnableBundle(cache, ref.name);
    expect(checked.report.ok).toBe(true);
    expect(checked.flow?.name).toBe('flow');
  });

  it('still rejects a named spec requested under another alias', async () => {
    const f = await setup();
    await expect(checkRunnableBundle(f.bundle, 'other')).rejects.toMatchObject({ kind: 'bundle_signature_invalid' });
  });

  it('still checks command availability without project configuration', async () => {
    const f = await setup();
    await writeFile(join(f.root, 'missing.yaml'), 'version: 0.1.0\nname: missing\nsteps:\n  - id: run\n    type: deterministic\n    command: flows-definitely-missing-command-337\n');
    const bundle = await buildFlow(join(f.root, 'missing.yaml'), join(f.root, 'dist/flows'), () => {});
    const checked = await checkRunnableBundle(bundle, 'missing');
    expect(checked.report.diagnostics).toContainEqual(expect.objectContaining({
      severity: 'warning', kind: 'command_unresolved',
    }));
  });
});
