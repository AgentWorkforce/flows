import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/**
 * Entry names never walked and never reported, matched exactly, at any depth,
 * before the entry's type is consulted — so a `.git` *file* (a worktree's
 * gitdir pointer) is skipped as surely as a `.git` directory. Exact names, not
 * prefixes: `.github`, `.relayflowd-notes` and every other author-chosen name
 * that merely starts the same way stays eligible.
 */
const SKIPPED_ENTRY_NAMES = new Set(['.git', '.relayflowd', 'node_modules']);

/**
 * A recursive snapshot of every regular file under `dir`, keyed by its
 * `dir`-relative POSIX path, valued by a content signature (size + sha256).
 * Content, not mtime: a fast rewrite inside the filesystem's timestamp
 * resolution must still count as a change — the same rule
 * `examples/research/shims/agent-cli.ts`'s `snapshot()` uses for the same
 * "did the agent actually write something" question.
 *
 * Dotfiles and dot-directories ARE eligible. `.workflow-artifacts/` is the
 * conventional place a flow tells its agents to write, and a blanket dot-prefix
 * skip made every review, report and evidence file written there invisible to
 * the journal — and so to an `artifact_exists` gate naming one, which could
 * then never pass. Only the three names in `SKIPPED_ENTRY_NAMES` are excluded:
 * `.git`, the default `.relayflowd` data dir, and `node_modules`. A data dir
 * the caller named explicitly is not one of those; the caller drops that whole
 * subtree from the diff instead (`worker-cli.ts`).
 *
 * Only regular files are signed; symlinks are not followed and directories are
 * descended, not recorded. A missing `dir` (an agent step whose cwd does not
 * exist yet) yields an empty snapshot rather than throwing. Only a vanished
 * path (`ENOENT`) is ever swallowed this way; any other filesystem error
 * (permissions, `ENOTDIR`, `EISDIR`, ...) propagates, because a step whose
 * artifact scan silently dropped files it could not read must not report a
 * successful, incomplete `artifacts` list as if it were the truth.
 */
export async function snapshotWorkspaceFiles(dir: string): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  await walk(dir, dir, out);
  return out;
}

async function walk(root: string, current: string, out: Map<string, string>): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch (error) {
    if (isEnoent(error)) return;
    throw error;
  }
  for (const entry of entries) {
    if (SKIPPED_ENTRY_NAMES.has(entry.name)) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, path, out);
      continue;
    }
    if (!entry.isFile()) continue;
    let info;
    try {
      info = await stat(path);
    } catch (error) {
      // A file can vanish between readdir and stat (a CLI's own temp file);
      // that is not an artifact, not a scan failure.
      if (isEnoent(error)) continue;
      throw error;
    }
    let bytes;
    try {
      bytes = await readFile(path);
    } catch (error) {
      if (isEnoent(error)) continue;
      throw error;
    }
    out.set(relative(root, path).split(sep).join('/'), `${info.size}:${createHash('sha256').update(bytes).digest('hex')}`);
  }
}

/** `dir`-relative paths present in `after` that are new or changed since `before`, sorted. */
export function diffWorkspaceFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [path, signature] of after) {
    if (before.get(path) !== signature) changed.push(path);
  }
  return changed.sort();
}
