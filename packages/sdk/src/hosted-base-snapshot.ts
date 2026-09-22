import { createHash } from 'node:crypto';
import {
  chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalize } from './canonical.js';
import { findPluginProject } from './plugin-loader.js';
import { PluginError } from './plugin-manifest.js';

const EXCLUDED_DIRECTORIES = new Set(['.flows', '.git', 'node_modules']);
const MAX_FILES = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;

interface SourceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

export interface HostedBaseSnapshot {
  readonly liveRoot: string;
  readonly liveDigest: string;
  readonly snapshotRoot: string;
  readonly snapshotFlowPath: string;
}

/**
 * Materialize the authored project source into a private, unique directory.
 * The base and every ordinary relative import therefore execute from the exact
 * buffered bytes represented by liveDigest, never a mutable deployment path or
 * a module cached for an earlier deployment.
 */
export async function createHostedBaseSnapshot(flowPath: string): Promise<HostedBaseSnapshot> {
  const origin = await realpath(resolve(flowPath));
  const discovered = findPluginProject(dirname(origin)) ?? dirname(origin);
  const liveRoot = await realpath(discovered);
  const flowRelative = relative(liveRoot, origin);
  if (flowRelative === '' || isAbsolute(flowRelative)
    || flowRelative === '..' || flowRelative.startsWith(`..${sep}`)) {
    throw invalid('Hosted base flow must be a file inside its project root.');
  }
  const files = await readSourceTree(liveRoot);
  const liveDigest = sourceDigest(files);
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'flows-hosted-base-'));
  await chmod(snapshotRoot, 0o700);
  try {
    for (const file of files) {
      const target = join(snapshotRoot, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.bytes, { flag: 'wx', mode: 0o400 });
    }
    const nodeModules = join(liveRoot, 'node_modules');
    try {
      if ((await lstat(nodeModules)).isDirectory()) {
        await symlink(nodeModules, join(snapshotRoot, 'node_modules'), 'dir');
      }
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
    if (sourceDigest(await readSourceTree(snapshotRoot)) !== liveDigest) {
      throw invalid('Hosted base private snapshot does not match its buffered source.');
    }
    return Object.freeze({
      liveRoot,
      liveDigest,
      snapshotRoot,
      snapshotFlowPath: join(snapshotRoot, flowRelative),
    });
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function hostedBaseSourceDigest(root: string): Promise<string> {
  return sourceDigest(await readSourceTree(root));
}

export async function removeHostedBaseSnapshot(snapshot: HostedBaseSnapshot): Promise<void> {
  await rm(snapshot.snapshotRoot, { recursive: true, force: true });
}

async function readSourceTree(root: string): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  let totalBytes = 0;
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const relativePath = prefix === '' ? entry.name : join(prefix, entry.name);
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) {
        await visit(absolutePath, relativePath);
      } else if (entry.isFile()) {
        const bytes = await readFile(absolutePath);
        totalBytes += bytes.byteLength;
        if (files.length >= MAX_FILES || totalBytes > MAX_BYTES) {
          throw invalid('Hosted base source tree exceeds the snapshot limit.');
        }
        files.push(Object.freeze({ path: relativePath, bytes, sha256: sha256(bytes) }));
      } else {
        throw invalid(`Hosted base source tree contains unsupported entry "${relativePath}".`);
      }
    }
  }
  try { await visit(root, ''); }
  catch (error) {
    if (error instanceof PluginError) throw error;
    throw invalid('Hosted base source tree is unreadable.');
  }
  return Object.freeze(files);
}

function sourceDigest(files: readonly SourceFile[]): string {
  return sha256(canonicalize(files.map(file => ({ path: file.path, sha256: file.sha256 }))));
}

function sha256(value: Uint8Array | string): string {
  return createHash('sha256').update(value).digest('hex');
}

function invalid(message: string): PluginError {
  return new PluginError('plugin_source_invalid', message);
}

function isMissing(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error
    && (error as { code?: unknown }).code === 'ENOENT';
}
