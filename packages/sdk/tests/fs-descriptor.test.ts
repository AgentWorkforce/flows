import { Dir, Dirent, Stats, closeSync, fstatSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  closeDescriptor,
  closeDirectory,
  lstatPath,
  openDirectory,
  openDescriptor,
  readDirectory,
  readDirectoryEntry,
  statDescriptor,
} from '../src/fs-descriptor.js';

const roots: string[] = [];

afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));

function fixture(): { directory: string; file: string } {
  const directory = mkdtempSync(join(tmpdir(), 'fs-descriptor-test-'));
  roots.push(directory);
  const file = join(directory, 'entry.txt');
  writeFileSync(file, 'entry');
  return { directory, file };
}

function restoreThen(prototype: object, previous: PropertyDescriptor | undefined): void {
  if (previous === undefined) delete (prototype as { then?: unknown }).then;
  else Object.defineProperty(prototype, 'then', previous);
}

describe('captured descriptor operations', () => {
  it('shadows native fs values before promise resolution reads their prototypes', async () => {
    const { directory, file } = fixture();
    const sample = openSync(file, 'r');
    const bigintStatsPrototype = Object.getPrototypeOf(fstatSync(sample, { bigint: true })) as object;
    closeSync(sample);
    const prototypes = [Array.prototype, Stats.prototype, bigintStatsPrototype, Dir.prototype, Dirent.prototype];
    const previous = prototypes.map(prototype => Object.getOwnPropertyDescriptor(prototype, 'then'));
    let poisonCalls = 0;
    try {
      for (const prototype of prototypes) {
        Object.defineProperty(prototype, 'then', {
          configurable: true,
          get() {
            poisonCalls += 1;
            return undefined;
          },
        });
      }

      const entries = await readDirectory(directory);
      expect(entries.map(entry => entry.name)).toEqual(['entry.txt']);
      expect(await lstatPath(file)).toBeInstanceOf(Stats);

      const descriptor = await openDescriptor(file, 0);
      try {
        expect((await statDescriptor(descriptor, { bigint: true })).size).toBe(5n);
      } finally {
        await closeDescriptor(descriptor);
      }

      const opened = await openDirectory(directory);
      try {
        expect((await readDirectoryEntry(opened))?.name).toBe('entry.txt');
      } finally {
        await closeDirectory(opened);
      }
    } finally {
      for (let index = 0; index < prototypes.length; index += 1) {
        restoreThen(prototypes[index]!, previous[index]);
      }
    }
    expect(poisonCalls).toBe(0);
  });
});
