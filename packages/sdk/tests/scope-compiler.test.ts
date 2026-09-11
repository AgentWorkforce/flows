import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileScopes, SCOPE_MODES } from '../src/scope-compiler.js';
import { readMountRegistry } from '../src/mount-registry.js';

const mounts = { acme: [{ path: 'api', modes: SCOPE_MODES }] };

describe('scope compiler', () => {
  it.each(SCOPE_MODES)('lowers %s into inert JSON', mode => {
    const result = compileScopes({ workspace: `acme/api: ${mode}` }, mounts);
    expect(result).toEqual({ scopes: [{ source: 'workspace', grant: `acme/api: ${mode}`,
      scope: { mount: 'acme', path: 'api', mode } }], diagnostics: [] });
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it.each(['acme/api', 'acme/api: write', 'acme/../secrets: readonly',
    'acme/api/./x: readonly', 'acme/api//x: readonly', 'acme/api/: readonly',
    'acme/api%2F..: readonly', 'acme/api\\secrets: readonly', 'acme/api*: readonly',
    '/acme/api: readonly', 'acme/api: readonly\n', 'acme/api: readonly, other/data: readonly'])('refuses invalid grant %s', grant => {
    expect(compileScopes({ workspace: grant }, mounts)).toMatchObject({ scopes: [],
      diagnostics: [{ kind: 'scope_syntax_invalid', grant }] });
  });

  it('lists the descriptor when the mount is unknown', () => {
    const result = compileScopes({ tools: { fs: 'missing/api: readonly' } }, mounts);
    expect(result.diagnostics).toMatchObject([{ kind: 'mount_unknown',
      scope: { mount: 'missing', path: 'api', mode: 'readonly' } }]);
    expect(result.scopes[0]?.scope).toEqual(result.diagnostics[0]?.scope);
  });

  it('refuses modes and prefixes unavailable on the mount', () => {
    const result = compileScopes({ workspace: ['acme/api: readwrite', 'acme/api-secret: readonly'] },
      { acme: [{ path: 'api', modes: ['readonly'] }] });
    expect(result.diagnostics.map(d => d.kind)).toEqual(['scope_ungrantable', 'scope_ungrantable']);
  });

  it('collects all failures and preserves step provenance', () => {
    const result = compileScopes({ workspace: 'invalid', tools: { fs: 'missing/api: append' },
      steps: [{ id: 'plan', workspace: ['acme/secret: readonly', 'acme/api/src: readonly'] }] }, mounts);
    expect(result.diagnostics.map(d => d.kind)).toEqual([
      'scope_syntax_invalid', 'mount_unknown', 'scope_ungrantable',
    ]);
    expect(result.scopes.at(-1)).toMatchObject({ stepId: 'plan',
      scope: { mount: 'acme', path: 'api/src', mode: 'readonly' } });
  });

  it('does not read an accessor while compiling declarations', () => {
    let reads = 0;
    expect(() => compileScopes({ get workspace() { reads++; return 'acme/api: readonly'; } }, mounts)).toThrow('accessors');
    expect(reads).toBe(0);
  });

  it('does not treat inherited object properties as mounts', () => {
    expect(compileScopes({ workspace: 'constructor/api: readonly' }, {}).diagnostics[0]?.kind).toBe('mount_unknown');
  });
});

describe('local relayfile manifest shim', () => {
  const directories: string[] = [];
  afterEach(() => {
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
  });
  function directory(): string {
    const path = mkdtempSync(join(tmpdir(), 'scope-manifest-'));
    directories.push(path);
    return path;
  }

  it('reads the nearest manifest and does not merge outer permissions', () => {
    const root = directory();
    const child = join(root, 'child');
    mkdirSync(child);
    writeFileSync(join(root, 'relayfile.mounts.json'), JSON.stringify({ version: 1, mounts }));
    expect(readMountRegistry(child)).toEqual(mounts);
    writeFileSync(join(child, 'relayfile.mounts.json'), JSON.stringify({ version: 1, mounts: {} }));
    expect(readMountRegistry(child)).toEqual({});
  });

  it.each([
    { version: 1, mounts: { acme: [{ path: '../api', modes: ['readonly'] }] } },
    { version: 1, mounts: { acme: [{ path: 'api', modes: ['all'] }] } },
    { version: 1, mounts: { acme: [{ path: 'api', modes: ['readonly'], extra: true }] } },
    { version: 2, mounts },
  ])('fails closed on malformed manifest %j', manifest => {
    const root = directory();
    writeFileSync(join(root, 'relayfile.mounts.json'), JSON.stringify(manifest));
    expect(() => readMountRegistry(root)).toThrow('Invalid relayfile mount');
  });
});
