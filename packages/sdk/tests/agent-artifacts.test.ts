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

  it('reports a file the agent wrote under a dot-directory', async () => {
    // `.workflow-artifacts/` is the conventional artifact directory; a blanket
    // dot-prefix skip made every file written there invisible to the journal,
    // so an `artifact_exists` gate naming one could never pass.
    const dir = tempDir();
    mkdirSync(join(dir, '.workflow-artifacts/reviews'), { recursive: true });
    writeFileSync(join(dir, '.workflow-artifacts/reviews/edited.md'), 'aaaa');
    writeFileSync(join(dir, '.workflow-artifacts/untouched.md'), 'same');
    const before = await snapshotWorkspaceFiles(dir);
    mkdirSync(join(dir, '.workflow-artifacts/x'), { recursive: true });
    writeFileSync(join(dir, '.workflow-artifacts/x/y.md'), 'findings');
    writeFileSync(join(dir, '.workflow-artifacts/reviews/edited.md'), 'bbbb');
    const after = await snapshotWorkspaceFiles(dir);
    expect(diffWorkspaceFiles(before, after))
      .toEqual(['.workflow-artifacts/reviews/edited.md', '.workflow-artifacts/x/y.md']);
  });

  it('keeps ordinary dotfiles and author dot-directories eligible, including names that merely resemble exclusions', async () => {
    const dir = tempDir();
    const before = await snapshotWorkspaceFiles(dir);
    writeFileSync(join(dir, '.env.example'), 'KEY=');
    mkdirSync(join(dir, '.github/workflows'), { recursive: true });
    writeFileSync(join(dir, '.github/workflows/ci.yml'), 'on: push');
    mkdirSync(join(dir, '.relayflowd-notes'));
    writeFileSync(join(dir, '.relayflowd-notes/todo.md'), 'later');
    mkdirSync(join(dir, 'evidence/.nested/.deeper'), { recursive: true });
    writeFileSync(join(dir, 'evidence/.nested/.deeper/proof.md'), 'proof');
    const after = await snapshotWorkspaceFiles(dir);
    expect(diffWorkspaceFiles(before, after)).toEqual([
      '.env.example',
      '.github/workflows/ci.yml',
      '.relayflowd-notes/todo.md',
      'evidence/.nested/.deeper/proof.md',
    ]);
  });

  it('skips exactly .git, .relayflowd and node_modules, at the root and nested', async () => {
    const dir = tempDir();
    const before = await snapshotWorkspaceFiles(dir);
    for (const name of ['.git', '.relayflowd', 'node_modules']) {
      mkdirSync(join(dir, name));
      writeFileSync(join(dir, name, 'noise.txt'), 'noise');
      mkdirSync(join(dir, 'sub', name), { recursive: true });
      writeFileSync(join(dir, 'sub', name, 'noise.txt'), 'noise');
    }
    const after = await snapshotWorkspaceFiles(dir);
    expect(diffWorkspaceFiles(before, after)).toEqual([]);
  });

  it('skips a regular .git file, as a linked worktree has', async () => {
    const dir = tempDir();
    const before = await snapshotWorkspaceFiles(dir);
    writeFileSync(join(dir, '.git'), 'gitdir: /elsewhere/.git/worktrees/w\n');
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
