import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

const SKIPPED_DIR_NAMES = new Set(['node_modules']);

/**
 * A recursive snapshot of every regular file under `dir`, keyed by its
 * `dir`-relative POSIX path, valued by a content signature (size + sha256).
 * Content, not mtime: a fast rewrite inside the filesystem's timestamp
 * resolution must still count as a change — the same rule
 * `examples/research/shims/agent-cli.ts`'s `snapshot()` uses for the same
 * "did the agent actually write something" question. Dotfiles/dotdirs
 * (`.git`, the kernel's own `.relayflowd` data dir, editor swap files, ...)
 * are never agent-authored content and are skipped, as is `node_modules`.
 * A missing `dir` (an agent step whose cwd does not exist yet) yields an
 * empty snapshot rather than throwing.
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
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith('.') || SKIPPED_DIR_NAMES.has(entry.name)) continue;
    const path = join(current, entry.name);
    if (entry.isDirectory()) {
      await walk(root, path, out);
      continue;
    }
    if (!entry.isFile()) continue;
    // A file can vanish between readdir and read (a CLI's own temp file);
    // that is not an artifact and must not surface as an error after the
    // step already spent its tokens.
    const info = await stat(path).catch(() => undefined);
    const bytes = info !== undefined ? await readFile(path).catch(() => undefined) : undefined;
    if (info !== undefined && bytes !== undefined) {
      out.set(relative(root, path).split(sep).join('/'), `${info.size}:${createHash('sha256').update(bytes).digest('hex')}`);
    }
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
