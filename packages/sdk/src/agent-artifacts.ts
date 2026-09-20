import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

const SKIPPED_DIR_NAMES = new Set(['node_modules']);

/**
 * A recursive snapshot of every regular file under `dir`, keyed by its
 * `dir`-relative POSIX path, valued by a content signature (size + sha256).
 * Content, not mtime: a fast rewrite inside the filesystem's timestamp
 * resolution must still count as a change — the same rule
 * `examples/research/shims/agent-cli.ts`'s `snapshot()` uses for the same
 * "did the agent actually write something" question. Dotfiles/dotdirs
 * (`.git`, a default `.relayflowd` data dir, editor swap files, ...) are never
 * agent-authored content and are skipped, as is `node_modules`. A data dir the
 * caller named explicitly is not a dotdir and so is not covered here; the
 * caller excludes it from the diff instead (`worker-cli.ts`).
 * A missing `dir` (an agent step whose cwd does not exist yet) yields an
 * empty snapshot rather than throwing. Only a vanished path (`ENOENT`) is
 * ever swallowed this way; any other filesystem error (permissions,
 * `ENOTDIR`, `EISDIR`, ...) propagates, because a step whose artifact scan
 * silently dropped files it could not read must not report a successful,
 * incomplete `artifacts` list as if it were the truth.
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
    if (entry.name.startsWith('.') || SKIPPED_DIR_NAMES.has(entry.name)) continue;
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
