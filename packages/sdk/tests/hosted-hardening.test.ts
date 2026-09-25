import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { assertBaseCompatible } from '../src/flow-extension-compat.js';
import type { FlowExtensionManifest } from '../src/flow-extension-manifest.js';
import { capturedSurfaceEntry } from '../src/hosted-extension-sandbox.js';
import { loadHostedExtensionArtifacts } from '../src/hosted-extension-runtime.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

/** A project whose lockfile names one extension, with no artifact materialized. */
function project(name: string): string {
  const root = mkdtempSync(join(tmpdir(), 'hosted-hardening-'));
  roots.push(root);
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'flows.json'), JSON.stringify({
    plugins: [`github:AgentWorkforce/flows@${'a'.repeat(40)}#extensions/babysitter`],
  }));
  writeFileSync(join(root, 'flows.lock.json'), JSON.stringify({
    version: 2,
    plugins: [{
      name, kind: 'flow-extension', version: '0.2.0',
      source: {
        host: 'github', owner: 'AgentWorkforce', repo: 'flows',
        sha: 'a'.repeat(40), path: 'extensions/babysitter',
      },
      digest: 'b'.repeat(64), manifestSha256: 'c'.repeat(64),
      order: 1, resolvedAt: '2026-09-22T12:00:00.000Z',
    }],
  }));
  writeFileSync(join(root, 'software-factory.flow.ts'), 'export default {};');
  return join(root, 'software-factory.flow.ts');
}

function manifest(base: FlowExtensionManifest['compat']['base']): FlowExtensionManifest {
  return {
    schema: 2, kind: 'flow-extension', name: 'babysitter', version: '0.2.0',
    compat: { surface: '*', sdk: '*', base },
    entry: 'babysitter.flow.ts',
    extends: { handlers: true, hooks: [] },
    triggers: [],
    permissions: { integrations: [], harnesses: [], mcp: [], writes: [] },
    preflight: { credentials: [], servers: [] },
  } as FlowExtensionManifest;
}

describe('hosted extension hardening', () => {
  it('resolves the Surface entry while this module initializes, before authored code can steer the loader', () => {
    const before = capturedSurfaceEntry();
    // A realpath: a linked workspace copy resolves outside node_modules.
    expect(before).toMatch(/surface[/\\]dist[/\\]index\.js$/);
    // What an authored module could do to the resolver once it is imported.
    const moduleExports = createRequire(import.meta.url)('node:module') as {
      _resolveFilename: (...args: unknown[]) => string;
    };
    const original = moduleExports._resolveFilename;
    const hostile = mkdtempSync(join(tmpdir(), 'hosted-hostile-surface-'));
    roots.push(hostile);
    mkdirSync(join(hostile, 'dist'), { recursive: true });
    writeFileSync(join(hostile, 'package.json'), JSON.stringify({ name: '@relayflows/surface', version: '0.0.0' }));
    writeFileSync(join(hostile, 'dist', 'index.js'), 'export {};\n');
    try {
      moduleExports._resolveFilename = function poisoned(request: unknown, ...rest: unknown[]): string {
        if (request === '@relayflows/surface') return join(hostile, 'dist', 'index.js');
        return original.call(this, request, ...rest);
      };
      // The capture already happened, so the poisoned resolver cannot be consulted.
      expect(capturedSurfaceEntry()).toBe(before);
      expect(capturedSurfaceEntry()).not.toContain(hostile);
    } finally {
      moduleExports._resolveFilename = original;
    }
  });

  it.each(['../escape', 'a/b', '.', '..', 'Babysitter', 'babysitter/../../etc', ''])(
    'refuses a hosted lock whose plugin name %j is not one safe path component',
    async name => {
      await expect(loadHostedExtensionArtifacts(project(name)))
        .rejects.toMatchObject({ code: 'plugin_lock_invalid' });
    },
  );

  it('still accepts an ordinary kebab-case lock name, failing later on the absent artifact', async () => {
    // Not plugin_lock_invalid: the name parses, and verification fails on bytes.
    await expect(loadHostedExtensionArtifacts(project('babysitter')))
      .rejects.not.toMatchObject({ code: 'plugin_lock_invalid' });
  });

  it('matches the first compat.base entry for a name, not the last', () => {
    const duplicated = manifest([
      Object.freeze({ name: 'software-factory', version: '2.0.22' }),
      Object.freeze({ name: 'software-factory', version: '9.9.9' }),
    ]);
    // First entry decides: 2.0.22 satisfies it, and the wider later duplicate cannot rescue 9.9.9.
    expect(() => assertBaseCompatible(duplicated, { name: 'software-factory', version: '2.0.22' })).not.toThrow();
    expect(() => assertBaseCompatible(duplicated, { name: 'software-factory', version: '9.9.9' }))
      .toThrow(expect.objectContaining({ code: 'plugin_incompatible' }));
  });

  it('keeps reporting every declared base name when none matches', () => {
    expect(() => assertBaseCompatible(
      manifest([Object.freeze({ name: 'software-factory', version: '*' }), Object.freeze({ name: 'garden', version: '*' })]),
      { name: 'release-manager', version: '1.0.0' },
    )).toThrow(/extends software-factory, garden, not "release-manager"/);
  });
});
