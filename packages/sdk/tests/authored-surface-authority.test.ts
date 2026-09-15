import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { packageTreeSha256 } from '../src/authored-flow-loader.js';

const directories: string[] = [];

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('Surface package authority', () => {
  it('excludes npm dependency state while pinning every published package file', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surface-authority-'));
    directories.push(root);
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, 'package.json'), '{"name":"@relayflows/surface","version":"2.0.10"}');
    await writeFile(join(root, 'dist', 'index.js'), 'export const flow = true;\n');
    await writeFile(join(root, 'dist', 'runtime.js'), 'export const runtime = true;\n');

    const publishedHash = await packageTreeSha256(root);

    await mkdir(join(root, 'node_modules', '.bin'), { recursive: true });
    await mkdir(join(root, 'node_modules', '@relayfile', 'adapter-core'), { recursive: true });
    await writeFile(join(root, 'node_modules', '@relayfile', 'adapter-core', 'package.json'), '{"version":"0.5.24"}');
    await symlink(
      join('..', '@relayfile', 'adapter-core', 'bin.js'),
      join(root, 'node_modules', '.bin', 'adapter-core'),
    );
    expect(await packageTreeSha256(root)).toBe(publishedHash);

    await writeFile(join(root, 'dist', 'runtime.js'), 'export const runtime = false;\n');
    expect(await packageTreeSha256(root)).not.toBe(publishedHash);
  });

  it('still refuses symlinks in the published package payload', async () => {
    const root = await mkdtemp(join(tmpdir(), 'surface-authority-'));
    directories.push(root);
    await writeFile(join(root, 'package.json'), '{"name":"@relayflows/surface","version":"2.0.10"}');
    await symlink('package.json', join(root, 'runtime.js'));

    await expect(packageTreeSha256(root)).rejects.toThrow('contains unsupported entry "runtime.js"');
  });
});
