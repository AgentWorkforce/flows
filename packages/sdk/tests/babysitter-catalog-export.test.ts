import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
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
  it('CLI refuses an existing output and leaves no file on validation failure', async () => {
    const a = await artifact();
    const directory = mkdtempSync(join(tmpdir(), 'babysitter-export-cli-'));
    try {
      // Replay only the GitHub responses used by the real resolver. The child
      // executes the actual CLI and built exporter; unexpected network is fatal.
      const responses: Record<string, { status: number; body: string }> = {};
      for (const url of [...new Set(a.github.calls)]) {
        const response = await a.github.fetch(url, { headers: {}, signal: new AbortController().signal });
        responses[url] = { status: response.status, body: Buffer.from(await response.arrayBuffer()).toString('base64') };
      }
      const preload = join(directory, 'github.mjs');
      writeFileSync(preload, `const responses = ${JSON.stringify(responses)};
globalThis.fetch = async url => {
  const response = responses[String(url)];
  if (!response) throw new Error('Unexpected network request: ' + url);
  return new Response(Buffer.from(response.body, 'base64'), { status: response.status });
};\n`);
      const output = join(directory, 'bundle.json');
      const invoke = (destination: string, digest = a.pin.digest) => spawnSync(process.execPath, [
        '--import', pathToFileURL(preload).href, resolve('scripts/export-babysitter-catalog.mjs'),
        ref, digest, a.pin.manifestSha256, destination,
      ], { encoding: 'utf8', timeout: 15_000 });
      const first = invoke(output);
      expect(first.status, first.stderr).toBe(0);
      const original = readFileSync(output);
      expect(JSON.parse(original.toString())).toMatchObject(a.pin);
      const duplicate = invoke(output);
      expect(duplicate.status, duplicate.stderr).toBe(1);
      expect(duplicate.stderr).toContain('EEXIST');
      expect(duplicate.stdout).toBe('');
      expect(readFileSync(output)).toEqual(original);
      const invalidOutput = join(directory, 'invalid.json');
      const invalid = invoke(invalidOutput, '0'.repeat(64));
      expect(invalid.status, invalid.stderr).toBe(1);
      expect(invalid.stderr).toContain('differs from the reviewed pin');
      expect(invalid.stdout).toBe('');
      expect(existsSync(invalidOutput)).toBe(false);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

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
