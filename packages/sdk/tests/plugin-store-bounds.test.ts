import { mkdtempSync, readdirSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { payloadManifest } from '../src/bundle.js';
import { materializePlugin, readStoredPluginFiles, verifyStoredPlugin } from '../src/plugin-store.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'plugin-store-bounds-'));
  roots.push(root);
  const stored = await materializePlugin(root, 'bounded', [
    { path: 'flows-plugin.json', data: Buffer.from('{"name":"bounded"}') },
    { path: 'entry.ts', data: Buffer.from('export default {};') },
    { path: 'nested/value.ts', data: Buffer.from('export const value = 1;') },
  ]);
  return stored;
}

describe('bounded plugin-store verification', () => {
  it('hashes the exact supplied buffers without ambient sort or map', () => {
    const sort = Array.prototype.sort;
    const map = Array.prototype.map;
    let calls = 0;
    let encoded: string | undefined;
    try {
      Array.prototype.sort = (() => {
        calls += 1;
        return [];
      }) as typeof Array.prototype.sort;
      Array.prototype.map = (() => {
        calls += 1;
        return [];
      }) as typeof Array.prototype.map;
      encoded = payloadManifest([
        { path: 'z.ts', data: Buffer.from('z') },
        { path: 'a.ts', data: Buffer.from('a') },
      ]);
    } finally {
      Array.prototype.sort = sort;
      Array.prototype.map = map;
    }
    expect(calls).toBe(0);
    expect(JSON.parse(encoded!)).toMatchObject([{ path: 'a.ts' }, { path: 'z.ts' }]);
  });

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
    const bigint = BigInt;
    let poisonCalls = 0;
    try {
      globalThis.BigInt = (() => {
        poisonCalls += 1;
        return 1n << 62n;
      }) as unknown as BigIntConstructor;
      await expect(verifyStoredPlugin(stored.directory, stored.digest)).rejects.toMatchObject({
        code: 'plugin_source_drift',
        message: expect.stringContaining('expected a bounded regular file'),
      });
    } finally {
      globalThis.BigInt = bigint;
    }
    expect(poisonCalls).toBe(0);
  });

  it('uses captured conversion and allocation intrinsics after size admission', async () => {
    const stored = await fixture();
    const number = Number;
    const allocUnsafe = Buffer.allocUnsafe;
    let poisonCalls = 0;
    try {
      globalThis.Number = ((value?: unknown) => {
        const stack = new Error().stack ?? '';
        const directCaller = stack.split('\n', 3)[2] ?? '';
        if (directCaller.includes('/src/plugin-store.')) {
          poisonCalls += 1;
          throw new Error('ambient Number must not run');
        }
        return number(value);
      }) as unknown as NumberConstructor;
      Buffer.allocUnsafe = ((size: number) => {
        const stack = new Error().stack ?? '';
        const directCaller = stack.split('\n', 3)[2] ?? '';
        if (directCaller.includes('/src/plugin-store.')) {
          poisonCalls += 1;
          throw new Error('ambient Buffer.allocUnsafe must not run');
        }
        return allocUnsafe(size);
      }) as typeof Buffer.allocUnsafe;
      await expect(verifyStoredPlugin(stored.directory, stored.digest)).resolves.toBeUndefined();
    } finally {
      globalThis.Number = number;
      Buffer.allocUnsafe = allocUnsafe;
    }
    expect(poisonCalls).toBe(0);
  });

  it('ignores inherited store test hooks when production omits them', async () => {
    const stored = await fixture();
    const names = ['beforeOpen', 'afterStat', 'beforeDirectoryStat'] as const;
    const previous = names.map(name => Object.getOwnPropertyDescriptor(Object.prototype, name));
    let poisonCalls = 0;
    try {
      for (const name of names) {
        Object.defineProperty(Object.prototype, name, {
          configurable: true,
          value: async () => {
            poisonCalls += 1;
            throw new Error(`inherited ${name} must not run`);
          },
        });
      }
      await expect(verifyStoredPlugin(stored.directory, stored.digest)).resolves.toBeUndefined();
    } finally {
      for (let index = 0; index < names.length; index += 1) {
        const descriptor = previous[index];
        if (descriptor === undefined) delete (Object.prototype as Record<string, unknown>)[names[index]!];
        else Object.defineProperty(Object.prototype, names[index]!, descriptor);
      }
    }
    expect(poisonCalls).toBe(0);
  });

  it('bounds a payload that grows after its admitted size was checked', async () => {
    const stored = await fixture();
    const raced = join(stored.directory, 'entry.ts');
    await expect(
      readStoredPluginFiles(stored.directory, stored.digest, {
        afterStat: async path => {
          if (path === raced) {
            writeFileSync(raced, Buffer.alloc(256_001));
          }
        },
      }),
    ).rejects.toMatchObject({
      code: 'plugin_source_drift',
      message: expect.stringContaining('changed while reading'),
    });
  });

  it.runIf(process.platform === 'linux')('closes a child descriptor when directory stat fails', async () => {
    const stored = await fixture();
    const before = readdirSync('/proc/self/fd').length;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      await expect(readStoredPluginFiles(stored.directory, stored.digest, {
        beforeDirectoryStat: async () => { throw new Error('injected directory stat failure'); },
      })).rejects.toMatchObject({
        code: 'plugin_source_drift',
        message: expect.stringContaining('nested/value.ts is missing'),
      });
    }
    expect(readdirSync('/proc/self/fd').length).toBeLessThanOrEqual(before + 2);
  });
});
