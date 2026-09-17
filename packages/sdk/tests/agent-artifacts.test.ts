import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { diffWorkspaceFiles, snapshotWorkspaceFiles } from '../src/agent-artifacts.js';

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'agent-artifacts-'));
  dirs.push(dir);
  return dir;
}

describe('snapshotWorkspaceFiles / diffWorkspaceFiles', () => {
  it('reports a newly written nested file as an artifact', async () => {
    const dir = tempDir();
    const before = await snapshotWorkspaceFiles(dir);
    mkdirSync(join(dir, 'research'));
    writeFileSync(join(dir, 'research', 'notes.md'), 'facts');
    const after = await snapshotWorkspaceFiles(dir);
    expect(diffWorkspaceFiles(before, after)).toEqual(['research/notes.md']);
  });

  it('reports a same-size content change to an existing file', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'post.md'), 'aaaa');
    const before = await snapshotWorkspaceFiles(dir);
    writeFileSync(join(dir, 'post.md'), 'bbbb');
    const after = await snapshotWorkspaceFiles(dir);
    expect(diffWorkspaceFiles(before, after)).toEqual(['post.md']);
  });

  it('ignores files that are unchanged', async () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'unrelated.txt'), 'same');
    const before = await snapshotWorkspaceFiles(dir);
    const after = await snapshotWorkspaceFiles(dir);
    expect(diffWorkspaceFiles(before, after)).toEqual([]);
  });

  it('skips dotdirs and node_modules', async () => {
    const dir = tempDir();
    const before = await snapshotWorkspaceFiles(dir);
    mkdirSync(join(dir, '.relayflowd'));
    writeFileSync(join(dir, '.relayflowd', 'kernel.log'), 'noise');
    mkdirSync(join(dir, 'node_modules'));
    writeFileSync(join(dir, 'node_modules', 'pkg.js'), 'noise');
    const after = await snapshotWorkspaceFiles(dir);
    expect(diffWorkspaceFiles(before, after)).toEqual([]);
  });

  it('yields an empty snapshot for a directory that does not exist yet', async () => {
    const dir = join(tempDir(), 'does-not-exist');
    expect(await snapshotWorkspaceFiles(dir)).toEqual(new Map());
  });

  it('propagates a non-ENOENT scan failure instead of silently omitting files', async () => {
    if (process.getuid?.() === 0) return; // root bypasses permission bits; nothing to assert
    const dir = tempDir();
    const locked = join(dir, 'locked');
    mkdirSync(locked);
    writeFileSync(join(locked, 'secret.txt'), 'x');
    try {
      await chmod(locked, 0o000);
      await expect(snapshotWorkspaceFiles(dir)).rejects.toMatchObject({ code: 'EACCES' });
    } finally {
      await chmod(locked, 0o755);
    }
  });
});
