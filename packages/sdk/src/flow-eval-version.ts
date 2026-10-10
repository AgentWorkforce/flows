// What a flow evaluation judges, by content: the flow version.
//
// For a flow file the version is the sha256 of a manifest of every local
// source the run reads, not of the entry file alone. Editing a helper module,
// a `use`d flow, or the project's extension lock changes what executes, so it
// must change the version too — otherwise `expectVersion` would accept code it
// never judged. Packages under node_modules are not part of the manifest; they
// are pinned by the project's own lockfile, which is. An evaluation executes a
// sealed copy of exactly these bytes (`sealFlowEvalSnapshot`).

import { createHash } from 'node:crypto';
import { existsSync, statSync } from 'node:fs';
import { chmod, mkdir, mkdtemp, readdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { canonicalize, specHash } from './canonical.js';
import { compileSpec, toKernelSpec } from './compile.js';
import { FlowEvalError } from './flow-eval-error.js';
import { parsePluginLock, type PluginLock } from './plugin-lock.js';
import { pluginStoreDirectory } from './plugin-store.js';
import type { FlowSpec } from './spec.js';

/** A flow source path (`.flow.ts`, `.flow.yaml`, spec JSON) or an in-memory spec. */
export type FlowEvalTarget = { path: string } | FlowSpec;

export interface FlowEvalVersion {
  /** `sha256:<hex>` over the manifest (or the kernel spec hash for an in-memory spec). */
  version: string;
  /** Manifest paths, relative to the entry's directory; empty for an in-memory spec. */
  files: string[];
}

/** Most local source files one version may span; past it the evaluation is refused, not truncated. */
export const MAX_FLOW_EVAL_SOURCES = 2_000;

const SOURCE_EXTENSIONS = ['.ts', '.mts', '.cts', '.js', '.mjs', '.cjs', '.json'];
const PROJECT_FILES = ['package.json', 'flows.json', 'flows.lock.json', 'package-lock.json', 'bun.lock', 'pnpm-lock.yaml', 'yarn.lock'];

export function isPathTarget(flow: FlowEvalTarget): flow is { path: string } {
  return typeof (flow as { path?: unknown }).path === 'string' && !('steps' in flow);
}

/** The version string alone. */
export async function flowEvalVersion(flow: FlowEvalTarget): Promise<string> {
  return (await flowEvalSources(flow)).version;
}

/** The version and the files it covers. */
export async function flowEvalSources(flow: FlowEvalTarget): Promise<FlowEvalVersion> {
  if (!isPathTarget(flow)) return { version: `sha256:${specHash(toKernelSpec(compileSpec(flow)))}`, files: [] };
  const { version, files } = await collectSources(flow.path);
  return { version, files: files.map(file => file.path) };
}

/** The sealed bytes a version names, from which every case gets its own copy. */
export interface FlowEvalSnapshot extends FlowEvalVersion {
  /**
   * A fresh, read-only copy for one case: its own directory, files and
   * directories without write permission, written from the buffers the
   * version hashed. An in-memory spec yields a deep-frozen clone.
   */
  materialize(): Promise<{ flow: FlowEvalTarget; dispose(): Promise<void> }>;
}

/**
 * Seal the flow before any case runs, and execute only copies of the seal.
 *
 * Hashing the working tree and then running it would let the tree change
 * between the two — an edit made after a check and restored before the next
 * would run bytes the report never named. The sources are read once, hashed,
 * and held in memory; each case then runs a fresh read-only copy written from
 * those buffers, so nothing a case does to its copy reaches the next case. A
 * local module the manifest could not see (a computed
 * `import(\`./rules/${kind}.js\`)`, a file read at runtime) is simply absent
 * from the copy, so such a run fails instead of executing unjudged code.
 *
 * Trust boundary: evaluated code runs as the caller, so it can still reach
 * anything the caller can — including `node_modules`, which is linked rather
 * than copied and pinned by the lockfile in the manifest. Containing hostile
 * code needs a sandbox; this seal makes sure the code that runs is the code
 * the version names.
 */
export async function sealFlowEvalSnapshot(flow: FlowEvalTarget): Promise<FlowEvalSnapshot> {
  if (!isPathTarget(flow)) {
    // Hash and execute the same detached copy: a caller mutating its object
    // later cannot change what the remaining cases run.
    const frozen = deepFreeze(structuredClone(flow));
    return { ...(await flowEvalSources(frozen)), materialize: async () => ({ flow: frozen, dispose: async () => {} }) };
  }
  const sources = await collectSources(flow.path);
  const root = commonDirectory(sources.absolute.map(file => file.path));
  const modules = nearestNodeModules(dirname(sources.entry));
  return {
    version: sources.version,
    files: sources.files.map(file => file.path),
    materialize: async () => {
      const directory = await mkdtemp(join(tmpdir(), 'flows-eval-snapshot-'));
      const dispose = async (): Promise<void> => {
        await makeWritable(directory);
        await rm(directory, { recursive: true, force: true });
      };
      try {
        for (const file of sources.absolute) {
          const target = join(directory, relative(root, file.path));
          await mkdir(dirname(target), { recursive: true });
          await writeFile(target, file.bytes, { mode: 0o444 });
        }
        if (modules !== undefined) await symlink(modules, join(directory, 'node_modules'), 'dir');
        await makeReadOnly(directory);
      } catch (error) {
        await dispose();
        throw error;
      }
      return { flow: { path: join(directory, relative(root, sources.entry)) }, dispose };
    },
  };
}

async function makeReadOnly(directory: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) await makeReadOnly(join(directory, entry.name));
  }
  await chmod(directory, 0o555);
}

async function makeWritable(directory: string): Promise<void> {
  try {
    await chmod(directory, 0o755);
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (entry.isDirectory()) await makeWritable(join(directory, entry.name));
    }
  } catch { /* already gone */ }
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

interface CollectedSources {
  entry: string;
  version: string;
  files: Array<{ path: string; sha256: string }>;
  absolute: Array<{ path: string; bytes: Buffer }>;
}

async function collectSources(path: string): Promise<CollectedSources> {
  let entry: string;
  try {
    entry = await realpath(path);
  } catch {
    throw new FlowEvalError('unreadable_flow', `Flow "${path}" is not readable.`);
  }
  const root = dirname(entry);
  const contents = new Map<string, Buffer>();
  const missing = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (contents.has(file)) continue;
    if (contents.size >= MAX_FLOW_EVAL_SOURCES) {
      throw new FlowEvalError('unreadable_flow', `Flow "${path}" reaches more than ${MAX_FLOW_EVAL_SOURCES} local source files.`);
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(file);
    } catch {
      throw new FlowEvalError('unreadable_flow', `Flow source "${file}" is not readable.`);
    }
    contents.set(file, bytes);
    if (!/\.(?:[mc]?[jt]s)$/u.test(file)) continue;
    for (const specifier of localSpecifiers(bytes.toString('utf8'))) {
      const targets = resolveLocal(dirname(file), specifier);
      if (targets.length === 0) missing.add(`${relative(root, dirname(file)) || '.'}:${specifier}`);
      for (const target of targets) if (!contents.has(target)) pending.push(target);
    }
  }
  // The nearest of each: package.json decides module semantics, flows.json and
  // its lock the extensions, and a package lockfile pins node_modules. Each is
  // found by walking up on its own, so a lockfile beside package.json (not
  // beside flows.json) still pins the version.
  for (const name of PROJECT_FILES) {
    const file = nearestFile(root, name);
    if (file !== undefined && !contents.has(file)) contents.set(file, await readFile(file));
  }
  // Locked flow extensions load from the project's content-addressed store,
  // so their payloads are part of what runs: hash and seal them too.
  const lockPath = nearestFile(root, 'flows.lock.json');
  if (lockPath !== undefined) {
    let lock: PluginLock;
    try {
      lock = parsePluginLock(JSON.parse(contents.get(lockPath)!.toString('utf8')));
    } catch (error) {
      throw new FlowEvalError('unreadable_flow', `flows.lock.json is not a valid plugin lock: ${error instanceof Error ? error.message : String(error)}`);
    }
    for (const entry of lock.plugins) {
      const store = pluginStoreDirectory(dirname(lockPath), entry.name, entry.digest);
      if (!existsSync(store)) {
        throw new FlowEvalError('unreadable_flow', `Locked extension ${entry.name} is not materialized at ${store}; run \`flows plugin verify\`.`);
      }
      for (const file of await listFiles(store)) if (!contents.has(file)) contents.set(file, await readFile(file));
    }
  }
  const absolute = [...contents.entries()].map(([file, bytes]) => ({ path: file, bytes }));
  const files = absolute
    .map(file => ({ path: relative(root, file.path) || basename(file.path), sha256: sha256(file.bytes) }))
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  // An unresolved import is part of the identity too: creating that file later changes what runs.
  const manifest = { entry: basename(entry), files, missing: [...missing].sort() };
  return { entry, version: `sha256:${sha256(canonicalize(manifest))}`, files, absolute };
}

async function listFiles(directory: string): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(path));
    else if (entry.isFile()) files.push(path);
  }
  return files;
}

function commonDirectory(paths: readonly string[]): string {
  let common = dirname(paths[0]!);
  for (const path of paths) {
    while (common !== dirname(common) && path !== common && !path.startsWith(common + sep)) common = dirname(common);
  }
  return common;
}

function nearestFile(start: string, name: string): string | undefined {
  for (let directory = start; ; directory = dirname(directory)) {
    const candidate = join(directory, name);
    if (existsSync(candidate)) return candidate;
    if (dirname(directory) === directory) return undefined;
  }
}

function nearestNodeModules(start: string): string | undefined {
  const found = nearestFile(start, 'node_modules');
  return found !== undefined && statSync(found).isDirectory() ? found : undefined;
}

/**
 * Relative module specifiers and relative `.flow.ts` string literals (the
 * `use:` header) in a source file. A lexical scan, deliberately: computing a
 * version must never execute the flow.
 */
export function localSpecifiers(source: string): string[] {
  const found = new Set<string>();
  const patterns = [
    /\b(?:import|export)\s+(?:type\s+)?[^'"`;]*?\bfrom\s*['"](\.{1,2}\/[^'"]+)['"]/gu,
    /\bimport\s*['"](\.{1,2}\/[^'"]+)['"]/gu,
    /\b(?:import|require)\s*\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)/gu,
    /['"](\.{1,2}\/[^'"\s]+\.flow\.ts)['"]/gu,
  ];
  for (const pattern of patterns) for (const match of source.matchAll(pattern)) found.add(match[1]!);
  return [...found];
}

/**
 * The files a relative specifier can load. Where a TypeScript sibling and a
 * JavaScript file both match (`./x.js` beside `./x.ts`), both are returned:
 * which one a loader picks is the loader's business, and the version must not
 * hash one while the run executes the other.
 */
function resolveLocal(from: string, specifier: string): string[] {
  const base = resolve(from, specifier.replace(/[?#].*$/u, ''));
  const isFile = (candidate: string): boolean => {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  };
  // TypeScript's NodeNext convention: import './x.js' names ./x.ts.
  const swapped = base.replace(/\.([mc]?)js$/u, '.$1ts');
  const direct = [...new Set([swapped, base])].filter(isFile);
  if (direct.length > 0) return direct;
  for (const candidate of [
    ...SOURCE_EXTENSIONS.map(extension => base + extension),
    ...SOURCE_EXTENSIONS.map(extension => join(base, `index${extension}`)),
  ]) if (isFile(candidate)) return [candidate];
  return [];
}

function sha256(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}
