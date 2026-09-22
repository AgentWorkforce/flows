import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { exportBabysitterCatalogBundle } from '../src/babysitter-catalog-export.js';
import { resolveExtensionSubmission } from '../src/flow-extension-submit.js';
import { SHA_A, SHA_B, fakeGithub } from './fake-github.js';

const ref = `github:AgentWorkforce/flows@${SHA_A}#examples/babysitter`;
const versions = { sdk: '2.0.25', surface: '2.0.25' };
const template = JSON.parse(readFileSync(resolve('../../testdata/plugins/extension-babysitter/flows-plugin.json'), 'utf8'));

async function artifact(change: (manifest: typeof template) => void = () => {}) {
  const manifest = structuredClone(template);
  manifest.permissions = { integrations: ['github'], harnesses: ['codex'], mcp: [], writes: ['cloud:babysitter-turn'] };
  change(manifest);
  const manifestBytes = JSON.stringify(manifest, null, 2) + '\n';
  const github = fakeGithub({ 'AgentWorkforce/flows': { refs: {}, commits: { [SHA_A]: { entries: [
    { path: 'examples/babysitter/flows-plugin.json', data: Buffer.from(manifestBytes) },
    // Export must not evaluate an entry, even while verifying its bytes.
    { path: 'examples/babysitter/babysitter.flow.ts', data: Buffer.from('throw new Error("must not execute");') },
    { path: 'examples/babysitter/binary.bin', data: Buffer.from([255, 0, 128]) },
  ] } } } });
  const options = { fetch: github.fetch, versions };
  const bundle = await resolveExtensionSubmission(ref, options);
  return { manifest, manifestBytes, github, options, pin: { ref, digest: bundle.digest, manifestSha256: bundle.manifestSha256 } };
}

describe('Babysitter catalog artifact export', () => {
  it('preserves digest-bound manifest and binary bytes without executing code', async () => {
    const a = await artifact(m => { m.source = { host: 'github', owner: 'AgentWorkforce', repo: 'flows', path: 'examples/babysitter' }; });
    const exported = await exportBabysitterCatalogBundle(a.pin, a.options);
    expect(exported.manifest).toEqual(a.manifest);
    expect(exported.files.find(f => f.path === 'flows-plugin.json')?.content).toBe(a.manifestBytes);
    expect(exported.files.find(f => f.path === 'binary.bin')).toMatchObject({ encoding: 'base64', content: '/wCA', bytes: 3 });
    expect(exported).toMatchObject(a.pin);
  });

  it.each(['main', 'v1.0.0', SHA_A.slice(0, 12)])('rejects mutable/noncanonical ref %s before fetching', async sha => {
    const a = await artifact();
    a.github.calls.length = 0;
    await expect(exportBabysitterCatalogBundle({ ...a.pin, ref: ref.replace(SHA_A, sha) }, a.options)).rejects.toThrow();
    expect(a.github.calls).toEqual([]);
  });

  it.each(['digest', 'manifestSha256'] as const)('rejects a changed %s', async key => {
    const a = await artifact();
    await expect(exportBabysitterCatalogBundle({ ...a.pin, [key]: '0'.repeat(64) }, a.options)).rejects.toThrow('differs from the reviewed pin');
  });

  it.each([
    (m: typeof template) => { m.permissions.harnesses = ['claude']; },
    (m: typeof template) => { m.permissions.writes.push('github:pull_request:merge'); },
    (m: typeof template) => { m.permissions.mcp = ['shell']; },
    (m: typeof template) => { m.extends.hooks = ['merge-gate']; },
    (m: typeof template) => { m.compat.base = [{ name: 'other', version: '*' }]; },
    (m: typeof template) => { m.name = 'other'; },
  ])('rejects overbroad or unrelated manifests', async change => {
    const a = await artifact(change);
    await expect(exportBabysitterCatalogBundle(a.pin, a.options)).rejects.toThrow();
  });

  it('rejects self-declared source drift', async () => {
    await expect(artifact(m => { m.source = { host: 'github', owner: 'AgentWorkforce', repo: 'flows', path: 'examples/babysitter', sha: SHA_B }; }))
      .rejects.toThrow('declares source');
  });
});
