import { createHash } from 'node:crypto';
import { readFile, readdir, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { isUnscannedEntryName } from './artifact-scan-policy.js';

function isEnoent(error: unknown): boolean {
  return error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT';
}

/** A file present on disk whose bytes this process is not permitted to read. */
function isUnreadable(error: unknown): boolean {
  const code = error instanceof Error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === 'EACCES' || code === 'EPERM';
}

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
 * path (`ENOENT`) is ever swallowed this way; a file whose bytes cannot be read
 * is recorded by size and reason instead of being skipped, and any other
 * filesystem error (`ENOTDIR`, `EIO`, an unreadable *directory*, ...)
 * propagates, because a step whose artifact scan silently dropped files it
 * could not read must not report a successful, incomplete `artifacts` list as
 * if it were the truth.
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
    if (isUnscannedEntryName(entry.name)) continue;
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
      if (!isUnreadable(error)) throw error;
      // A file whose bytes are unreadable is still accounted for — by size
      // and reason, which can never collide with a content hash — rather
      // than dropped or made to fail the scan. `bun build --compile` creates
      // its output in its cwd with `O_CREAT|O_EXCL` and mode 000, writes the
      // (tens of megabytes) executable into it, then renames it onto the
      // --outfile; `bundle-typescript.ts` runs exactly that with cwd set to
      // the flow's own directory. So any tree a build is running in holds an
      // unreadable file for seconds at a time, and failing closed here lets
      // a neighbouring process fail an agent step that has done its work.
      out.set(signedPath(root, path), `${info.size}:unreadable:${(error as NodeJS.ErrnoException).code}`);
      continue;
    }
    out.set(signedPath(root, path), `${info.size}:${createHash('sha256').update(bytes).digest('hex')}`);
  }
}

function signedPath(root: string, path: string): string {
  return relative(root, path).split(sep).join('/');
}

/** `dir`-relative paths present in `after` that are new or changed since `before`, sorted. */
export function diffWorkspaceFiles(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [];
  for (const [path, signature] of after) {
    if (before.get(path) !== signature) changed.push(path);
  }
  return changed.sort();
}
