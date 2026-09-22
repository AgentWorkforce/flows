import { mkdtempSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { materializePlugin, readStoredPluginFiles, verifyStoredPlugin } from '../src/plugin-store.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'plugin-store-bounds-'));
  roots.push(root);
  const stored = await materializePlugin(root, 'bounded', [
    { path: 'flows-plugin.json', data: Buffer.from('{"name":"bounded"}') },
    { path: 'entry.ts', data: Buffer.from('export default {};') },
  ]);
  return stored;
}

describe('bounded plugin-store verification', () => {
  it('refuses an oversized sparse payload before buffering it', async () => {
    const stored = await fixture();
    truncateSync(join(stored.directory, 'entry.ts'), 256_001);
    await expect(verifyStoredPlugin(stored.directory, stored.digest)).rejects.toMatchObject({
      code: 'plugin_source_drift',
      message: expect.stringContaining('expected a bounded regular file'),
    });
  });

  it('refuses an oversized sparse manifest before hashing it', async () => {
    const stored = await fixture();
    truncateSync(join(stored.directory, 'manifest.json'), 4_000_001);
    await expect(verifyStoredPlugin(stored.directory, stored.digest)).rejects.toMatchObject({
      code: 'plugin_source_drift',
      message: expect.stringContaining('expected a bounded regular file'),
    });
  });

  it('bounds a payload that grows after its admitted size was checked', async () => {
    const stored = await fixture();
    const raced = join(stored.directory, 'entry.ts');
    await expect(readStoredPluginFiles(stored.directory, stored.digest, {
      afterStat: async path => {
        if (path === raced) {
          writeFileSync(raced, Buffer.alloc(256_001));
        }
      },
    })).rejects.toMatchObject({
      code: 'plugin_source_drift',
      message: expect.stringContaining('changed while reading'),
    });
  });
});
