import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { open as openFileHandle } from 'node:fs/promises';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createHostedBaseSnapshot,
  hostedBaseSourceDigest,
  removeHostedBaseSnapshot,
} from '../src/hosted-base-snapshot.js';
import { loadHostedExtensionRuntime } from '../src/hosted-extension-runtime.js';

const roots: string[] = [];
const require = createRequire(import.meta.url);
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture() {
  const project = mkdtempSync(join(tmpdir(), 'hosted-base-snapshot-test-'));
  roots.push(project);
  writeFileSync(join(project, 'package.json'), '{"type":"module"}');
  writeFileSync(join(project, 'flows.json'), '{}');
  const flowPath = join(project, 'software-factory.flow.ts');
  const source = `throw new Error('tenant base must not execute');\n`;
  writeFileSync(flowPath, source);
  return { project, flowPath, source };
}

describe('hosted base private snapshot', () => {
  it('keeps the buffered base bytes when the live source changes', async () => {
    const { flowPath, source } = fixture();
    const snapshot = await createHostedBaseSnapshot(flowPath);
    try {
      writeFileSync(flowPath, `throw new Error('live replacement');\n`);
      expect(readFileSync(snapshot.snapshotFlowPath, 'utf8')).toBe(source);
      expect(await hostedBaseSourceDigest(snapshot.liveSources)).not.toBe(snapshot.liveDigest);
    } finally {
      await removeHostedBaseSnapshot(snapshot);
    }
  });

  it('keeps source digests sensitive when ambient Array.map is poisoned', async () => {
    const { project } = fixture();
    const sources = [{ root: project, prefix: '' }];
    const before = await hostedBaseSourceDigest(sources);
    writeFileSync(join(project, 'helper.ts'), `export const identity = 'changed';\n`);
    const originalMap = Array.prototype.map;
    let poisonCalls = 0;
    let after: string | undefined;
    try {
      Array.prototype.map = function poisonedMap() {
        poisonCalls += 1;
        return [];
      } as typeof Array.prototype.map;
      after = await hostedBaseSourceDigest(sources);
    } finally {
      Array.prototype.map = originalMap;
    }
    expect(poisonCalls).toBe(0);
    expect(after).not.toBe(before);
  });

  it('excludes project node_modules from the admitted generation', async () => {
    const { project, flowPath } = fixture();
    const dependency = join(project, 'node_modules/local-identity');
    mkdirSync(dependency, { recursive: true });
    writeFileSync(join(dependency, 'package.json'), '{"name":"local-identity"}');
    writeFileSync(join(dependency, 'index.js'), `throw new Error('must not execute');\n`);
    const snapshot = await createHostedBaseSnapshot(flowPath);
    try {
      expect(() => readFileSync(join(snapshot.snapshotRoot, 'node_modules/local-identity/index.js'))).toThrow();
      const before = await hostedBaseSourceDigest(snapshot.liveSources);
      writeFileSync(join(dependency, 'index.js'), `throw new Error('replacement');\n`);
      expect(await hostedBaseSourceDigest(snapshot.liveSources)).toBe(before);
    } finally {
      await removeHostedBaseSnapshot(snapshot);
    }
  });

  it('refuses an oversized source file before buffering its contents', async () => {
    const { project, flowPath } = fixture();
    const oversized = join(project, 'oversized.bin');
    writeFileSync(oversized, '');
    truncateSync(oversized, 64 * 1024 * 1024 + 1);
    await expect(createHostedBaseSnapshot(flowPath)).rejects.toMatchObject({
      code: 'plugin_source_invalid',
      message: expect.stringContaining('snapshot entry or byte limit'),
    });
  });

  it.each(['flows.json', 'flows.lock.json'])('refuses oversized sparse %s before parsing it', async declaration => {
    const { project, flowPath } = fixture();
    const path = join(project, declaration);
    if (!existsSync(path)) writeFileSync(path, '');
    truncateSync(path, 1024 * 1024 + 1);
    await expect(loadHostedExtensionRuntime(flowPath)).rejects.toMatchObject({
      code: 'plugin_source_invalid',
      message: expect.stringContaining('bounded regular file'),
    });
  });

  it('captures conversion and allocation across declarations and source snapshots', async () => {
    const { flowPath } = fixture();
    const number = Number;
    const allocUnsafe = Buffer.allocUnsafe;
    let poisonCalls = 0;
    try {
      globalThis.Number = ((value?: unknown) => {
        const stack = new Error().stack ?? '';
        const directCaller = stack.split('\n', 3)[2] ?? '';
        if (
          directCaller.includes('/src/hosted-base-snapshot.') ||
          directCaller.includes('/src/hosted-extension-runtime.')
        ) {
          poisonCalls += 1;
          throw new Error('ambient Number must not run');
        }
        return number(value);
      }) as unknown as NumberConstructor;
      Buffer.allocUnsafe = ((size: number) => {
        const stack = new Error().stack ?? '';
        const directCaller = stack.split('\n', 3)[2] ?? '';
        if (
          directCaller.includes('/src/hosted-base-snapshot.') ||
          directCaller.includes('/src/hosted-extension-runtime.')
        ) {
          poisonCalls += 1;
          throw new Error('ambient Buffer.allocUnsafe must not run');
        }
        return allocUnsafe(size);
      }) as typeof Buffer.allocUnsafe;
      await expect(loadHostedExtensionRuntime(flowPath)).rejects.toMatchObject({
        code: 'plugin_source_invalid',
        message: expect.stringContaining('reviewed Software Factory base source'),
      });
    } finally {
      globalThis.Number = number;
      Buffer.allocUnsafe = allocUnsafe;
    }
    expect(poisonCalls).toBe(0);
  });

  it('keeps declaration and reviewed-base reads bound after builtin export synchronization', async () => {
    const { flowPath } = fixture();
    const builtinFs = require('node:fs') as typeof import('node:fs');
    const builtinPath = require('node:path') as typeof import('node:path');
    const originalOpenSync = builtinFs.openSync;
    const originalReadFile = builtinFs.promises.readFile;
    const originalExistsSync = builtinFs.existsSync;
    const originalResolve = builtinPath.resolve;
    const originalJoin = builtinPath.join;
    const originalDirname = builtinPath.dirname;
    let poisonCalls = 0;
    const directProductionCaller = (): boolean => {
      const directCaller = (new Error().stack ?? '').split('\n', 4)[3] ?? '';
      return directCaller.includes('/src/hosted-extension-runtime.');
    };
    try {
      Object.defineProperty(builtinFs, 'openSync', {
        ...Object.getOwnPropertyDescriptor(builtinFs, 'openSync'),
        value: (...args: unknown[]) => {
          if (directProductionCaller()) {
            poisonCalls += 1;
            throw new Error('ambient openSync must not run');
          }
          return Reflect.apply(originalOpenSync, builtinFs, args);
        },
      });
      Object.defineProperty(builtinFs.promises, 'readFile', {
        ...Object.getOwnPropertyDescriptor(builtinFs.promises, 'readFile'),
        value: async (...args: unknown[]) => {
          if (directProductionCaller()) {
            poisonCalls += 1;
            throw new Error('ambient readFile must not run');
          }
          return await Reflect.apply(originalReadFile, builtinFs.promises, args);
        },
      });
      Object.defineProperty(builtinFs, 'existsSync', {
        ...Object.getOwnPropertyDescriptor(builtinFs, 'existsSync'),
        value: (...args: unknown[]) => {
          const caller = (new Error().stack ?? '').split('\n', 4)[3] ?? '';
          if (caller.includes('/src/hosted-project.')) {
            poisonCalls += 1;
            throw new Error('ambient existsSync must not run');
          }
          return Reflect.apply(originalExistsSync, builtinFs, args);
        },
      });
      for (const [name, original] of [
        ['resolve', originalResolve], ['join', originalJoin], ['dirname', originalDirname],
      ] as const) {
        Object.defineProperty(builtinPath, name, {
          ...Object.getOwnPropertyDescriptor(builtinPath, name),
          value: (...args: unknown[]) => {
            const caller = (new Error().stack ?? '').split('\n', 4)[3] ?? '';
            if (caller.includes('/src/hosted-project.')) {
              poisonCalls += 1;
              throw new Error(`ambient path.${name} must not run`);
            }
            return Reflect.apply(original, builtinPath, args);
          },
        });
      }
      syncBuiltinESMExports();
      await expect(loadHostedExtensionRuntime(flowPath)).rejects.toMatchObject({
        code: 'plugin_source_invalid',
        message: expect.stringContaining('reviewed Software Factory base source'),
      });
    } finally {
      Object.defineProperty(builtinFs, 'openSync', {
        ...Object.getOwnPropertyDescriptor(builtinFs, 'openSync'),
        value: originalOpenSync,
      });
      Object.defineProperty(builtinFs.promises, 'readFile', {
        ...Object.getOwnPropertyDescriptor(builtinFs.promises, 'readFile'),
        value: originalReadFile,
      });
      Object.defineProperty(builtinFs, 'existsSync', {
        ...Object.getOwnPropertyDescriptor(builtinFs, 'existsSync'),
        value: originalExistsSync,
      });
      Object.defineProperty(builtinPath, 'resolve', {
        ...Object.getOwnPropertyDescriptor(builtinPath, 'resolve'), value: originalResolve,
      });
      Object.defineProperty(builtinPath, 'join', {
        ...Object.getOwnPropertyDescriptor(builtinPath, 'join'), value: originalJoin,
      });
      Object.defineProperty(builtinPath, 'dirname', {
        ...Object.getOwnPropertyDescriptor(builtinPath, 'dirname'), value: originalDirname,
      });
      syncBuiltinESMExports();
    }
    expect(poisonCalls).toBe(0);
  });

  it('reads through captured descriptors and charges admitted descriptor sizes', async () => {
    const { project, flowPath } = fixture();
    const sample = await openFileHandle(flowPath, 'r');
    const fileHandlePrototype = Object.getPrototypeOf(sample) as {
      read: (...args: unknown[]) => unknown;
    };
    const fileHandleRead = fileHandlePrototype.read;
    await sample.close();
    const typedArrayPrototype = Object.getPrototypeOf(Uint8Array.prototype) as object;
    const byteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')!;
    let poisonCalls = 0;
    try {
      fileHandlePrototype.read = function poisonedRead(this: unknown, ...args: unknown[]) {
        poisonCalls += 1;
        return Reflect.apply(fileHandleRead, this, args);
      };
      Object.defineProperty(typedArrayPrototype, 'byteLength', {
        ...byteLength,
        get(this: Uint8Array) {
          const stack = new Error().stack ?? '';
          const directCaller = stack.split('\n', 3)[2] ?? '';
          if (directCaller.includes('hosted-base-snapshot.')) {
            poisonCalls += 1;
            return 0;
          }
          return Reflect.apply(byteLength.get!, this, []);
        },
      });
      await expect(hostedBaseSourceDigest([{ root: project, prefix: '' }])).resolves.toMatch(/^[a-f0-9]{64}$/);
    } finally {
      fileHandlePrototype.read = fileHandleRead;
      Object.defineProperty(typedArrayPrototype, 'byteLength', byteLength);
    }
    expect(poisonCalls).toBe(0);
  });

  it('bounds a file that grows after its admitted size was checked', async () => {
    const { project } = fixture();
    const raced = join(project, 'raced.bin');
    writeFileSync(raced, 'small');
    await expect(
      hostedBaseSourceDigest([{ root: project, prefix: '' }], {
        afterStat: async path => {
          if (path === raced) truncateSync(raced, 64 * 1024 * 1024 + 1);
        },
      }),
    ).rejects.toMatchObject({
      code: 'plugin_source_invalid',
      message: expect.stringContaining('changed while reading "raced.bin"'),
    });
  });

  it.runIf(process.platform === 'linux' && existsSync('/usr/bin/mkfifo'))(
    'opens a substituted FIFO without blocking before rejecting it',
    async () => {
      const { project } = fixture();
      const raced = join(project, 'raced.txt');
      writeFileSync(raced, 'regular');
      let release: ReturnType<typeof setTimeout> | undefined;
      const started = Date.now();
      try {
        await expect(
          hostedBaseSourceDigest([{ root: project, prefix: '' }], {
            beforeOpen: async path => {
              if (path !== raced) return;
              rmSync(raced);
              const result = spawnSync('/usr/bin/mkfifo', [raced]);
              if (result.status !== 0) throw new Error(result.stderr.toString());
              // If O_NONBLOCK is removed, release the read-only open so the test
              // fails on elapsed time instead of hanging the test process.
              release = setTimeout(() => writeFileSync(raced, 'release'), 1_000);
            },
          }),
        ).rejects.toMatchObject({
          code: 'plugin_source_invalid',
          message: expect.stringContaining('unsupported entry "raced.txt"'),
        });
        expect(Date.now() - started).toBeLessThan(500);
      } finally {
        if (release !== undefined) clearTimeout(release);
      }
    },
  );

  it('stops streaming project entries at the shared count limit', async () => {
    const { project, flowPath } = fixture();
    for (let index = 0; index < 10_001; index += 1) {
      writeFileSync(join(project, `empty-${index}.txt`), '');
    }
    await expect(createHostedBaseSnapshot(flowPath)).rejects.toMatchObject({
      code: 'plugin_source_invalid',
      message: expect.stringContaining('snapshot entry or byte limit'),
    });
  });
});
