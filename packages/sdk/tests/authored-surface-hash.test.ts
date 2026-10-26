import * as fsPromises from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, relative, sep } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { packageTreeSha256 } from '../src/authored-flow-loader.js';

// The source imports readFile by name; mocking the module makes it spy-able.
vi.mock('node:fs/promises', async (importOriginal) => ({
  ...await importOriginal<typeof import('node:fs/promises')>(),
}));

const realReadFile = (await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises')).readFile;
const directories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) {
    await fsPromises.rm(directory, { recursive: true, force: true });
  }
});

/** The serial walk this hash has always been: sorted entries, one awaited read per file. */
async function serialTreeSha256(root: string): Promise<string> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await fsPromises.readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (directory === root && entry.name === 'node_modules') continue;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else files.push(path);
    }
  }
  await visit(root);
  const hash = createHash('sha256');
  for (const path of files) {
    const bytes = await realReadFile(path);
    hash.update(relative(root, path).split(sep).join('/')).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  return hash.digest('hex');
}

/**
 * 80 files over nested directories, created in the walk's sorted order, sized
 * so concurrent reads finish out of order.
 */
async function payloadTree(): Promise<{ root: string; files: string[] }> {
  const root = await fsPromises.mkdtemp(join(tmpdir(), 'surface-hash-'));
  directories.push(root);
  const files: string[] = [];
  for (let index = 0; index < 80; index += 1) {
    const path = join(root, 'dist', `group-${Math.floor(index / 20)}`, `file-${String(index).padStart(2, '0')}.js`);
    await fsPromises.mkdir(dirname(path), { recursive: true });
    await fsPromises.writeFile(path, `export const value${index} = ${JSON.stringify('x'.repeat((index * 7919) % 20_000))};\n`);
    files.push(path);
  }
  await fsPromises.writeFile(join(root, 'package.json'), '{"name":"@relayflows/surface","version":"2.0.10"}');
  return { root, files };
}

/** Count and delay every readFile, optionally failing chosen paths. */
function delayedReads(delayMs: (path: string) => number, fail: (path: string) => Error | undefined = () => undefined) {
  const started: string[] = [];
  let inFlight = 0, maxInFlight = 0;
  vi.spyOn(fsPromises, 'readFile').mockImplementation((async (path: string) => {
    started.push(path);
    inFlight += 1;
    maxInFlight = Math.max(maxInFlight, inFlight);
    try {
      await new Promise(resolve => setTimeout(resolve, delayMs(path)));
      const error = fail(path);
      if (error !== undefined) throw error;
      return await realReadFile(path);
    } finally { inFlight -= 1; }
  }) as typeof fsPromises.readFile);
  return { started, maxInFlight: () => maxInFlight };
}

describe('Surface package tree hash', () => {
  it('hashes the installed @relayflows/surface exactly as the serial walk does', async () => {
    const require = createRequire(import.meta.url);
    let root = dirname(require.resolve('@relayflows/surface/runtime'));
    while (!(await fsPromises.readdir(root)).includes('package.json')) root = dirname(root);
    expect(await packageTreeSha256(root)).toBe(await serialTreeSha256(root));
  });

  it('reads files concurrently and still hashes them in path order', async () => {
    const { root, files } = await payloadTree();
    const reads = delayedReads(path => (files.length - files.indexOf(path)) % 9);
    expect(await packageTreeSha256(root)).toBe(await serialTreeSha256(root));
    expect(reads.maxInFlight()).toBeGreaterThan(1);
    expect(reads.maxInFlight()).toBeLessThanOrEqual(32);
  });

  it('starts no new read after a failure and throws the error the serial walk meets first', async () => {
    const { root, files } = await payloadTree();
    // files[3] fails late, files[5] fails at once: the serial walk meets files[3] first.
    const reads = delayedReads(
      path => (path === files[3] ? 40 : 0),
      path => (path === files[3] || path === files[5] ? new Error(`unreadable ${relative(root, path)}`) : undefined),
    );
    await expect(packageTreeSha256(root)).rejects.toThrow(`unreadable ${relative(root, files[3]!)}`);
    expect(reads.started.length).toBeLessThan(files.length);
  });
});
