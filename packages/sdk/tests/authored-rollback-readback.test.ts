import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';
import { AUTHORED_PARALLEL_ROOT_KIND, AUTHORED_PARALLEL_ROOT_KIND_V3 } from '../src/authored-verdict.js';

// Optional compatibility check against an existing, unmodified published SDK.
// No daemon, install, source loading or authored effects are needed here.
const oldSdk = process.env['FLOWS_2052_SDK'];
it.skipIf(!oldSdk)('2.0.52 reads v2 but refuses v3 before any resume operation', async () => {
  expect(JSON.parse(readFileSync(join(oldSdk!, 'package.json'), 'utf8')).version).toBe('2.0.52');
  const old = await import(/* @vite-ignore */ pathToFileURL(join(oldSdk!, 'dist/authored-root.js')).href);
  const surface = { packageName: '@relayflows/surface', version: '2.0.52',
    packageSha256: 'a'.repeat(64), runtimeSha256: 'b'.repeat(64) };
  const metadata = { kind: AUTHORED_PARALLEL_ROOT_KIND_V3, flowName: 'rollback', flowPath: '/unused.flow.ts',
    sourceSha256: 'c'.repeat(64), surface,
    sources: [{ path: '/unused.flow.ts', sourceSha256: 'c'.repeat(64), surface }],
    extensions: [], inputPresent: false,
    identityVersion: 2, executionMode: 'parallel' };
  const operations: string[] = [];
  const journal = new Proxy({}, { get(_target, key) {
    if (key === 'journalRead') return async () => {
      operations.push('journalRead');
      return { entries: [{ entry_type: 'run.spawned', payload: { spec: { steps: [{
        id: 'authored-root', instruction: JSON.stringify(metadata),
        surfaces: { streams: [{ stream: 'authored-root-rollback' }] },
      }] } } }] };
    };
    return () => { operations.push(String(key)); throw new Error(`unexpected operation: ${String(key)}`); };
  } });
  // Positive control: the old runtime recognizes the same metadata as v2.
  metadata.kind = AUTHORED_PARALLEL_ROOT_KIND;
  await expect(old.readAuthoredRootMetadata(journal, 'root')).resolves.toMatchObject({ kind: metadata.kind });
  metadata.kind = AUTHORED_PARALLEL_ROOT_KIND_V3;
  operations.length = 0;
  await expect(old.resumeDurableAuthoredFlow('root', journal, { dataDir: '/unused' }))
    .rejects.toThrow('authored root journal has malformed authority metadata');
  expect(operations).toEqual(['journalRead']);
});
