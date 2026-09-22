import { constants } from 'node:fs';
import { chmod, mkdir, mkdtemp, opendir, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { canonicalize } from './canonical.js';
import { sha256 } from './bundle.js';
import {
  closeDescriptor,
  closeDirectory,
  descriptorIsDirectory,
  descriptorIsFile,
  directoryEntryIsDirectory,
  directoryEntryIsFile,
  openDescriptor,
  readDescriptor,
  readDirectoryEntry,
  statDescriptor,
} from './fs-descriptor.js';
import { findHostedProject } from './hosted-project.js';
import {
  assertHostedPromiseSafety,
  frozenHostedPromiseValue,
  hostedPromiseValue,
} from './hosted-promise-safety.js';
import { PluginError } from './plugin-manifest.js';

const EXCLUDED_DIRECTORIES = new Set(['.flows', '.git', 'node_modules']);
const CHMOD = chmod;
const MKDIR = mkdir;
const MKDTEMP = mkdtemp;
const OPENDIR = opendir;
const READDIR = readdir;
const REALPATH = realpath;
const RM = rm;
const WRITE_FILE = writeFile;
const TMPDIR = tmpdir;
const PATH_DIRNAME = dirname;
const PATH_IS_ABSOLUTE = isAbsolute;
const PATH_JOIN = join;
const PATH_RELATIVE = relative;
const PATH_RESOLVE = resolve;
const PATH_SEPARATOR = sep;
const ARRAY_PUSH = Function.prototype.call.bind(Array.prototype.push) as <T>(array: T[], value: T) => number;
const ARRAY_SORT = Function.prototype.call.bind(Array.prototype.sort) as <T>(
  array: T[],
  compare?: (left: T, right: T) => number,
) => T[];
const OBJECT_CREATE = Object.create;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const BIG_INT = BigInt;
const BUFFER_ALLOC_UNSAFE = Buffer.allocUnsafe;
const NUMBER = Number;
const SET_HAS = Function.prototype.call.bind(Set.prototype.has) as <T>(set: Set<T>, value: T) => boolean;
const STRING_LOCALE_COMPARE = Function.prototype.call.bind(String.prototype.localeCompare) as (
  value: string,
  other: string,
) => number;
const STRING_STARTS_WITH = Function.prototype.call.bind(String.prototype.startsWith) as (
  value: string,
  search: string,
) => boolean;
const MAX_ENTRIES = 10_000;
const MAX_BYTES = 64 * 1024 * 1024;
const MAX_DEPTH = 64;
const READ_FLAGS = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;

interface SourceFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly sha256: string;
}

interface SourceBudget {
  entries: number;
  bytes: number;
}

/** @internal Deterministic race seams for this security boundary's tests. */
export interface HostedBaseSnapshotTestHooks {
  readonly beforeOpen?: (path: string) => Promise<void>;
  readonly afterStat?: (path: string) => Promise<void>;
}

const EMPTY_HOSTED_BASE_HOOKS = OBJECT_FREEZE(
  OBJECT_CREATE(null),
) as HostedBaseSnapshotTestHooks;

export interface HostedBaseSourceRoot {
  readonly root: string;
  readonly prefix: string;
}

export interface HostedBaseSnapshot {
  readonly liveSources: readonly HostedBaseSourceRoot[];
  readonly liveDigest: string;
  readonly snapshotRoot: string;
  readonly snapshotFlowPath: string;
  readonly snapshotFlowSha256: string;
}

/**
 * Materialize project source without importing tenant code. Project
 * node_modules is never linked or read. Every admitted source byte is
 * represented in liveDigest and copied to the private identity directory.
 */
export async function createHostedBaseSnapshot(
  flowPath: string,
  projectRootOverride?: string,
): Promise<HostedBaseSnapshot> {
  assertHostedPromiseSafety('plugin_source_invalid');
  const origin = await REALPATH(PATH_RESOLVE(flowPath));
  const discovered = projectRootOverride ?? findHostedProject(PATH_DIRNAME(origin)) ?? PATH_DIRNAME(origin);
  const projectRoot = await REALPATH(discovered);
  const flowRelative = PATH_RELATIVE(projectRoot, origin);
  if (
    flowRelative === '' ||
    PATH_IS_ABSOLUTE(flowRelative) ||
    flowRelative === '..' ||
    STRING_STARTS_WITH(flowRelative, `..${PATH_SEPARATOR}`)
  ) {
    throw invalid('Hosted base flow must be a file inside its project root.');
  }
  const liveSources = frozenHostedPromiseValue([OBJECT_FREEZE({ root: projectRoot, prefix: '' })]);
  const files = await readAuthorityFiles(liveSources);
  const liveDigest = sourceDigest(files);
  const liveFlow = sourceFileAt(files, flowRelative);
  if (liveFlow === undefined) throw invalid('Hosted base flow is missing from its admitted source.');
  const snapshotRoot = await MKDTEMP(PATH_JOIN(TMPDIR(), 'flows-hosted-base-'));
  await CHMOD(snapshotRoot, 0o700);
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!;
      const target = PATH_JOIN(snapshotRoot, file.path);
      await MKDIR(PATH_DIRNAME(target), { recursive: true, mode: 0o700 });
      await WRITE_FILE(target, file.bytes, { flag: 'wx', mode: 0o400 });
    }
    const snapshotFiles = await readSnapshotTree(snapshotRoot);
    const snapshotDigest = sourceDigest(snapshotFiles);
    if (snapshotDigest !== liveDigest) {
      throw invalid('Hosted base private snapshot does not match its buffered source.');
    }
    const snapshotFlow = sourceFileAt(snapshotFiles, flowRelative);
    if (snapshotFlow === undefined || snapshotFlow.sha256 !== liveFlow.sha256) {
      throw invalid('Hosted base private snapshot does not contain its buffered flow source.');
    }
    return frozenHostedPromiseValue({
      liveSources,
      liveDigest,
      snapshotRoot,
      snapshotFlowPath: PATH_JOIN(snapshotRoot, flowRelative),
      snapshotFlowSha256: snapshotFlow.sha256,
    });
  } catch (error) {
    await RM(snapshotRoot, { recursive: true, force: true });
    throw error;
  }
}

export async function hostedBaseSourceDigest(
  sources: readonly HostedBaseSourceRoot[],
  hooks: HostedBaseSnapshotTestHooks = EMPTY_HOSTED_BASE_HOOKS,
): Promise<string> {
  assertHostedPromiseSafety('plugin_source_invalid');
  return sourceDigest(await readAuthorityFiles(sources, hooks));
}

export async function removeHostedBaseSnapshot(snapshot: HostedBaseSnapshot): Promise<void> {
  await RM(snapshot.snapshotRoot, { recursive: true, force: true });
}

async function readAuthorityFiles(
  sources: readonly HostedBaseSourceRoot[],
  hooks: HostedBaseSnapshotTestHooks = EMPTY_HOSTED_BASE_HOOKS,
): Promise<readonly SourceFile[]> {
  const budget: SourceBudget = { entries: 0, bytes: 0 };
  const files: SourceFile[] = [];
  for (let sourceIndex = 0; sourceIndex < sources.length; sourceIndex += 1) {
    const source = sources[sourceIndex]!;
    const sourceFiles = await readTree(source.root, source.prefix, budget, hooks);
    for (let fileIndex = 0; fileIndex < sourceFiles.length; fileIndex += 1) {
      ARRAY_PUSH(files, sourceFiles[fileIndex]!);
    }
  }
  ARRAY_SORT(files, (left, right) => STRING_LOCALE_COMPARE(left.path, right.path));
  return frozenHostedPromiseValue(files);
}

async function readSnapshotTree(root: string): Promise<readonly SourceFile[]> {
  const files: SourceFile[] = [];
  const budget: SourceBudget = { entries: 0, bytes: 0 };
  async function visit(directory: string, prefix: string): Promise<void> {
    const entries = await READDIR(directory, { withFileTypes: true });
    ARRAY_SORT(entries, (left, right) => STRING_LOCALE_COMPARE(left.name, right.name));
    for (let index = 0; index < entries.length; index += 1) {
      const entry = entries[index]!;
      budget.entries += 1;
      if (budget.entries > MAX_ENTRIES) throw tooLarge();
      const path = prefix === '' ? entry.name : PATH_JOIN(prefix, entry.name);
      const absolute = PATH_JOIN(directory, entry.name);
      if (directoryEntryIsDirectory(entry)) await visit(absolute, path);
      else if (directoryEntryIsFile(entry)) {
        const descriptor = await openDescriptor(absolute, READ_FLAGS);
        try {
          const before = await statDescriptor(descriptor, { bigint: true });
          if (!descriptorIsFile(before) || before.size < 0n || before.size > BIG_INT(MAX_BYTES - budget.bytes))
            throw tooLarge();
          const expectedBytes = NUMBER(before.size);
          const bytes = await readBounded(descriptor, expectedBytes, path);
          const after = await statDescriptor(descriptor, { bigint: true });
          if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
            throw invalid(`Hosted base snapshot changed while reading "${path}".`);
          }
          budget.bytes += expectedBytes;
          ARRAY_PUSH(files, OBJECT_FREEZE({ path, bytes, sha256: sha256(bytes) }));
        } finally {
          await closeDescriptor(descriptor);
        }
      } else throw invalid(`Hosted base snapshot contains unsupported entry "${path}".`);
    }
  }
  await visit(root, '');
  ARRAY_SORT(files, (left, right) => STRING_LOCALE_COMPARE(left.path, right.path));
  return frozenHostedPromiseValue(files);
}

async function readTree(
  root: string,
  prefix: string,
  budget: SourceBudget,
  hooks: HostedBaseSnapshotTestHooks,
): Promise<readonly SourceFile[]> {
  if (process.platform !== 'linux') {
    throw invalid('Hosted base source snapshotting requires Linux.');
  }
  const files: SourceFile[] = [];
  async function visit(directory: number, relativeDirectory: string, depth: number): Promise<void> {
    if (depth > MAX_DEPTH) throw tooLarge();
    const entries = await OPENDIR(`/proc/self/fd/${directory}`);
    try {
      for (;;) {
        const entry = await readDirectoryEntry(entries);
        if (entry === null) break;
        if (SET_HAS(EXCLUDED_DIRECTORIES, entry.name)) continue;
        budget.entries += 1;
        if (budget.entries > MAX_ENTRIES) throw tooLarge();
        const relativePath = relativeDirectory === '' ? entry.name : PATH_JOIN(relativeDirectory, entry.name);
        const absolutePath = PATH_JOIN(root, relativePath);
        await ownHook(hooks, 'beforeOpen')?.(absolutePath);
        const descriptor = await openDescriptor(`/proc/self/fd/${directory}/${entry.name}`, READ_FLAGS);
        try {
          const before = await statDescriptor(descriptor, { bigint: true });
          if (descriptorIsDirectory(before)) {
            await visit(descriptor, relativePath, depth + 1);
          } else if (descriptorIsFile(before)) {
            if (before.size < 0n || before.size > BIG_INT(MAX_BYTES - budget.bytes)) throw tooLarge();
            const expectedBytes = NUMBER(before.size);
            await ownHook(hooks, 'afterStat')?.(absolutePath);
            const bytes = await readBounded(descriptor, expectedBytes, relativePath);
            const after = await statDescriptor(descriptor, { bigint: true });
            if (after.size !== before.size || after.mtimeNs !== before.mtimeNs || after.ctimeNs !== before.ctimeNs) {
              throw invalid(`Hosted base source changed while reading "${relativePath}".`);
            }
            budget.bytes += expectedBytes;
            ARRAY_PUSH(
              files,
              OBJECT_FREEZE({
                path: prefix === '' ? relativePath : PATH_JOIN(prefix, relativePath),
                bytes,
                sha256: sha256(bytes),
              }),
            );
          } else {
            throw invalid(`Hosted base authority contains unsupported entry "${relativePath}".`);
          }
        } finally {
          await closeDescriptor(descriptor);
        }
      }
    } finally {
      await closeDirectory(entries);
    }
  }
  try {
    const rootDescriptor = await openDescriptor(root, READ_FLAGS);
    try {
      if (!descriptorIsDirectory(await statDescriptor(rootDescriptor, { bigint: true }))) {
        throw invalid('Hosted base source root is not a directory.');
      }
      await visit(rootDescriptor, '', 0);
    } finally {
      await closeDescriptor(rootDescriptor);
    }
  } catch (error) {
    if (error instanceof PluginError) throw error;
    throw invalid('Hosted base source or trusted dependency is unreadable.');
  }
  return frozenHostedPromiseValue(files);
}

function ownHook(
  hooks: HostedBaseSnapshotTestHooks,
  name: keyof HostedBaseSnapshotTestHooks,
): ((path: string) => Promise<void>) | undefined {
  const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(hooks, name);
  return descriptor !== undefined && 'value' in descriptor && typeof descriptor.value === 'function'
    ? descriptor.value as (path: string) => Promise<void>
    : undefined;
}

async function readBounded(descriptor: number, expectedBytes: number, relativePath: string): Promise<Buffer> {
  const bytes = BUFFER_ALLOC_UNSAFE(expectedBytes);
  let offset = 0;
  while (offset < expectedBytes) {
    const bytesRead = await readDescriptor(descriptor, bytes, offset, expectedBytes - offset, offset);
    if (bytesRead === 0) {
      throw invalid(`Hosted base source changed while reading "${relativePath}".`);
    }
    offset += bytesRead;
  }
  const extra = BUFFER_ALLOC_UNSAFE(1);
  if ((await readDescriptor(descriptor, extra, 0, 1, expectedBytes)) !== 0) {
    throw invalid(`Hosted base source changed while reading "${relativePath}".`);
  }
  return hostedPromiseValue(bytes);
}

function tooLarge(): PluginError {
  return invalid('Hosted base source exceeds the snapshot entry or byte limit.');
}

function sourceDigest(files: readonly SourceFile[]): string {
  const records: Array<{ path: string; sha256: string }> = [];
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index]!;
    records[index] = { path: file.path, sha256: file.sha256 };
  }
  return sha256(canonicalize(records));
}

function sourceFileAt(files: readonly SourceFile[], path: string): SourceFile | undefined {
  for (let index = 0; index < files.length; index += 1) {
    if (files[index]!.path === path) return files[index];
  }
  return undefined;
}

function invalid(message: string): PluginError {
  return new PluginError('plugin_source_invalid', message);
}
