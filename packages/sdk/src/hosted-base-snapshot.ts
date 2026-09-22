import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, open, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
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

interface SourceBudget {
  files: number;
  bytes: number;
}

export interface HostedBaseSourceRoot {
  readonly root: string;
  readonly prefix: string;
}

export interface HostedBaseSnapshot {
  readonly liveSources: readonly HostedBaseSourceRoot[];
  readonly liveDigest: string;
  readonly snapshotRoot: string;
  readonly snapshotFlowPath: string;
}

/**
 * Materialize project source without importing tenant code. Project
 * node_modules is never linked or read. Every admitted source byte is
 * represented in liveDigest and copied to the private identity directory.
 */
export async function createHostedBaseSnapshot(flowPath: string): Promise<HostedBaseSnapshot> {
  const origin = await realpath(resolve(flowPath));
  const discovered = findPluginProject(dirname(origin)) ?? dirname(origin);
  const projectRoot = await realpath(discovered);
  const flowRelative = relative(projectRoot, origin);
  if (flowRelative === '' || isAbsolute(flowRelative)
    || flowRelative === '..' || flowRelative.startsWith(`..${sep}`)) {
    throw invalid('Hosted base flow must be a file inside its project root.');
  }
  const liveSources = Object.freeze([
    Object.freeze({ root: projectRoot, prefix: '' }),
  ]);
  const files = await readAuthorityFiles(liveSources);
  const liveDigest = sourceDigest(files);
  const snapshotRoot = await mkdtemp(join(tmpdir(), 'flows-hosted-base-'));
  await chmod(snapshotRoot, 0o700);
  try {
    for (const file of files) {
      const target = join(snapshotRoot, file.path);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await writeFile(target, file.bytes, { flag: 'wx', mode: 0o400 });
    }
    const snapshotFiles = await readSnapshotTree(snapshotRoot);
    const snapshotDigest = sourceDigest(snapshotFiles);
    if (snapshotDigest !== liveDigest) {
      throw invalid('Hosted base private snapshot does not match its buffered source.');
    }
    return Object.freeze({
      liveSources,
      liveDigest,
      snapshotRoot,
      snapshotFlowPath: join(snapshotRoot, flowRelative),
    });
  } catch (error) {
    await rm(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function hostedBaseSourceDigest(
  sources: readonly HostedBaseSourceRoot[],
): Promise<string> {
  return sourceDigest(await readAuthorityFiles(sources));
}

export async function removeHostedBaseSnapshot(snapshot: HostedBaseSnapshot): Promise<void> {
  await rm(snapshot.snapshotRoot, { recursive: true, force: true });
}

async function readAuthorityFiles(sources: readonly HostedBaseSourceRoot[]): Promise<readonly SourceFile[]> {
  const budget: SourceBudget = { files: 0, bytes: 0 };
  const files: SourceFile[] = [];
  for (const source of sources) files.push(...await readTree(source.root, source.prefix, budget));
  files.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze(files);
}

async function readSnapshotTree(root: string): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = prefix === '' ? entry.name : join(prefix, entry.name);
      const absolute = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolute, path);
      else if (entry.isFile()) {
        const bytes = await readFile(absolute);
        files.push(Object.freeze({ path, bytes, sha256: sha256(bytes) }));
      } else throw invalid(`Hosted base snapshot contains unsupported entry "${path}".`);
    }
  }
  await visit(root, '');
  files.sort((left, right) => left.path.localeCompare(right.path));
  return Object.freeze(files);
}

async function readTree(
  root: string,
  prefix: string,
  budget: SourceBudget,
): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  async function visit(directory: string, relativeDirectory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      if (EXCLUDED_DIRECTORIES.has(entry.name)) continue;
      const relativePath = relativeDirectory === '' ? entry.name : join(relativeDirectory, entry.name);
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else if (entry.isFile()) {
        budget.files += 1;
        if (budget.files > MAX_FILES) throw tooLarge();
        const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const before = await handle.stat({ bigint: true });
          if (!before.isFile() || before.size < 0n
            || before.size > BigInt(MAX_BYTES - budget.bytes)) throw tooLarge();
          budget.bytes += Number(before.size);
          const bytes = await handle.readFile();
          const after = await handle.stat({ bigint: true });
          if (bytes.byteLength !== Number(before.size) || after.size !== before.size
            || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
            throw invalid(`Hosted base source changed while reading "${relativePath}".`);
          }
          files.push(Object.freeze({
            path: prefix === '' ? relativePath : join(prefix, relativePath),
            bytes,
            sha256: sha256(bytes),
          }));
        } finally {
          await handle.close();
        }
      } else throw invalid(`Hosted base authority contains unsupported entry "${relativePath}".`);
    }
  }
  try { await visit(root, ''); }
  catch (error) {
    if (error instanceof PluginError) throw error;
    throw invalid('Hosted base source or trusted dependency is unreadable.');
  }
  return Object.freeze(files);
}

function tooLarge(): PluginError {
  return invalid('Hosted base source exceeds the snapshot file or byte limit.');
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
