import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHostedBaseSnapshot,
  hostedBaseIdentityFromSnapshot,
  hostedBaseSourceDigest,
  removeHostedBaseSnapshot,
} from '../src/hosted-base-snapshot.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'hosted-base-snapshot-test-'));
  roots.push(root);
  const project = join(root, 'project');
  const surface = join(root, 'trusted-surface');
  mkdirSync(project, { recursive: true });
  mkdirSync(join(surface, 'dist'), { recursive: true });
  writeFileSync(join(project, 'package.json'), '{"type":"module"}');
  const flowPath = join(project, 'software-factory.flow.ts');
  writeFileSync(flowPath, `
    import { flow } from '@relayflows/surface';
    export default flow('software-factory', async f => f.done('success'));
  `);
  writeFileSync(join(surface, 'package.json'), JSON.stringify({
    name: '@relayflows/surface', type: 'module', exports: './dist/index.js',
  }));
  writeFileSync(join(surface, 'dist/shared.js'), `
    const definitions = new WeakMap();
    export function flow(name) {
      const handle = async () => {};
      definitions.set(handle, { name, header: {} });
      return handle;
    }
    export function getFlowDefinition(handle) { return definitions.get(handle); }
  `);
  writeFileSync(join(surface, 'dist/index.js'), `export { flow } from './shared.js';\n`);
  writeFileSync(join(surface, 'dist/flow.js'), `export { getFlowDefinition } from './shared.js';\n`);
  return { flowPath, surfaceEntry: join(surface, 'dist/index.js'), shared: join(surface, 'dist/shared.js') };
}

describe('hosted base private snapshot', () => {
  it('imports copied host package bytes when the live package changes before import', async () => {
    const { flowPath, surfaceEntry, shared } = fixture();
    const snapshot = await createHostedBaseSnapshot(flowPath, surfaceEntry);
    try {
      writeFileSync(shared, `throw new Error('live replacement executed');\n`);
      await expect(hostedBaseIdentityFromSnapshot(snapshot)).resolves.toEqual({
        name: 'software-factory',
      });
      await expect(hostedBaseSourceDigest(snapshot.liveSources)).resolves.not.toBe(snapshot.liveDigest);
    } finally {
      await removeHostedBaseSnapshot(snapshot);
    }
  });

  it('detects a live host package change after the copied identity was loaded', async () => {
    const { flowPath, surfaceEntry, shared } = fixture();
    const snapshot = await createHostedBaseSnapshot(flowPath, surfaceEntry);
    try {
      await expect(hostedBaseIdentityFromSnapshot(snapshot)).resolves.toEqual({
        name: 'software-factory',
      });
      expect(await hostedBaseSourceDigest(snapshot.liveSources)).toBe(snapshot.liveDigest);
      writeFileSync(shared, `throw new Error('post-load replacement');\n`);
      expect(await hostedBaseSourceDigest(snapshot.liveSources)).not.toBe(snapshot.liveDigest);
    } finally {
      await removeHostedBaseSnapshot(snapshot);
    }
  });
});
