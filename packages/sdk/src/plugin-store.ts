import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, opendir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { payloadManifest, safePath, sha256 } from './bundle.js';
import { MAX_PLUGIN_FILE_BYTES, MAX_PLUGIN_FILES, MAX_PLUGIN_TOTAL_BYTES } from './plugin-github.js';
import { PluginError } from './plugin-manifest.js';

/**
 * Where a flow-extension plugin's bytes live inside a project:
 * `<project>/.flows/plugins/<name>@sha256:<digest>/`, content-addressed like
 * the bundle cache and never `node_modules`. `manifest.json` in that directory
 * is the payload manifest whose sha256 is the digest, so a directory can be
 * re-verified without the network — and, because the lockfile records the
 * same digest, drift between what was installed and what is on disk is a
 * refusal, not a surprise.
 */
export const PLUGIN_STORE = '.flows/plugins';
const MAX_PLUGIN_MANIFEST_BYTES = 4_000_000;
const MAX_PLUGIN_STORE_ENTRIES = 10_000;
const ARRAY_IS_ARRAY = Array.isArray;
const BUFFER_TO_STRING = Function.prototype.call.bind(Buffer.prototype.toString) as (
  value: Buffer, encoding: BufferEncoding,
) => string;
const JSON_PARSE = JSON.parse;
const NUMBER_IS_SAFE_INTEGER = Number.isSafeInteger;
const OBJECT_FREEZE = Object.freeze;
const REGEXP_TEST = Function.prototype.call.bind(RegExp.prototype.test) as (
  pattern: RegExp, value: string,
) => boolean;
const SET = Set;
const SET_ADD = Function.prototype.call.bind(Set.prototype.add) as <T>(set: Set<T>, value: T) => Set<T>;
const SET_FOR_EACH = Function.prototype.call.bind(Set.prototype.forEach) as <T>(
  set: Set<T>, callback: (value: T) => void,
) => void;
const SET_HAS = Function.prototype.call.bind(Set.prototype.has) as <T>(set: Set<T>, value: T) => boolean;
const STRING_SPLIT = Function.prototype.call.bind(String.prototype.split) as (
  value: string, separator: string,
) => string[];
const STRING_STARTS_WITH = Function.prototype.call.bind(String.prototype.startsWith) as (
  value: string, search: string,
) => boolean;
const READ_FLAGS = constants.O_RDONLY
  | (constants.O_NOFOLLOW ?? 0)
  | (constants.O_NONBLOCK ?? 0);

export function pluginStoreDirectory(root: string, name: string, digest: string): string {
  return join(resolve(root), PLUGIN_STORE, `${name}@sha256:${digest}`);
}

export interface StoredPluginFile { readonly path: string; readonly data: Uint8Array }

/** @internal Deterministic race seams for the bounded store reader. */
export interface StoredPluginReadTestHooks {
  readonly beforeOpen?: (path: string) => Promise<void>;
  readonly afterStat?: (path: string) => Promise<void>;
}

/** Write the files atomically; an existing directory is verified instead of overwritten. */
export async function materializePlugin(root: string, name: string, files: readonly StoredPluginFile[]): Promise<{ directory: string; digest: string }> {
  const manifest = payloadManifest(files);
  const digest = sha256(manifest);
  const directory = pluginStoreDirectory(root, name, digest);
  let exists = false;
  try { await lstat(directory); exists = true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (exists) { await verifyStoredPlugin(directory, digest); return { directory, digest }; }
  const parent = dirname(directory);
  await mkdir(parent, { recursive: true });
  const staging = await mkdtemp(join(parent, '.install-'));
  try {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index]!;
      if (!safePath(file.path) || file.path === 'manifest.json') throw new PluginError('plugin_path_invalid', `${file.path}: invalid plugin path.`);
      await mkdir(dirname(join(staging, file.path)), { recursive: true });
      await writeFile(join(staging, file.path), file.data, { mode: 0o644 });
    }
    await writeFile(join(staging, 'manifest.json'), manifest);
    try { await rename(staging, directory); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EEXIST' && code !== 'ENOTEMPTY') throw error;
      await verifyStoredPlugin(directory, digest);
    }
  } finally { await rm(staging, { recursive: true, force: true }); }
  return { directory, digest };
}

async function regularFile(
  root: string,
  path: string,
  maxBytes: number,
  expectedBytes?: number,
  hooks: StoredPluginReadTestHooks = {},
): Promise<Buffer> {
  const absolute = join(root, path);
  const handle = await openStoredFile(root, path, hooks);
  try {
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.size < 0n || before.size > BigInt(maxBytes)
      || (expectedBytes !== undefined && before.size !== BigInt(expectedBytes))) {
      throw new PluginError('plugin_source_drift', `${path}: expected a bounded regular file.`);
    }
    await hooks.afterStat?.(absolute);
    const size = Number(before.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const result = await handle.read(bytes, offset, size - offset, offset);
      if (result.bytesRead === 0) {
        throw new PluginError('plugin_source_drift', `${path}: changed while reading.`);
      }
      offset += result.bytesRead;
    }
    const extra = Buffer.allocUnsafe(1);
    if ((await handle.read(extra, 0, 1, size)).bytesRead !== 0) {
      throw new PluginError('plugin_source_drift', `${path}: changed while reading.`);
    }
    const after = await handle.stat({ bigint: true });
    if (after.size !== before.size || after.mtimeNs !== before.mtimeNs
      || after.ctimeNs !== before.ctimeNs) {
      throw new PluginError('plugin_source_drift', `${path}: changed while reading.`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function openStoredFile(
  root: string,
  path: string,
  hooks: StoredPluginReadTestHooks,
): Promise<Awaited<ReturnType<typeof open>>> {
  const parts = STRING_SPLIT(path, '/');
  if (process.platform !== 'linux') {
    for (let i = 1; i < parts.length; i++) {
      let parent = root;
      for (let index = 0; index < i; index += 1) parent = join(parent, parts[index]!);
      if (!(await lstat(parent)).isDirectory()) {
        throw new PluginError('plugin_source_drift', `${path}: expected a regular file, without symlinks.`);
      }
    }
    await hooks.beforeOpen?.(join(root, path));
    return await open(join(root, path), READ_FLAGS);
  }
  let directory = await open(resolve(root), READ_FLAGS);
  try {
    if (!(await directory.stat()).isDirectory()) {
      throw new PluginError('plugin_source_drift', `${path}: plugin store root is not a directory.`);
    }
    for (let index = 0; index < parts.length - 1; index += 1) {
      const part = parts[index]!;
      const child = await open(`/proc/self/fd/${directory.fd}/${part}`, READ_FLAGS);
      if (!(await child.stat()).isDirectory()) {
        await child.close();
        throw new PluginError('plugin_source_drift', `${path}: expected a regular file, without symlinks.`);
      }
      await directory.close();
      directory = child;
    }
    await hooks.beforeOpen?.(join(root, path));
    return await open(`/proc/self/fd/${directory.fd}/${parts[parts.length - 1]!}`, READ_FLAGS);
  } finally {
    await directory.close();
  }
}

/** Re-hash a materialized plugin and compare with the digest the lockfile recorded. */
export async function verifyStoredPlugin(
  directory: string,
  expectedDigest: string,
  hooks: StoredPluginReadTestHooks = {},
): Promise<void> {
  await readVerifiedStoredPluginFiles(directory, expectedDigest, hooks);
}

async function readVerifiedStoredPluginFiles(
  directory: string,
  expectedDigest: string,
  hooks: StoredPluginReadTestHooks,
): Promise<readonly { path: string; data: Buffer }[]> {
  const drift = (message: string): never => { throw new PluginError('plugin_source_drift', `${directory}: ${message}`); };
  let manifest: Buffer;
  try {
    if (!(await lstat(directory)).isDirectory()) return drift('not a directory');
    manifest = await regularFile(directory, 'manifest.json', MAX_PLUGIN_MANIFEST_BYTES, undefined, hooks);
  } catch (error) { return drift(error instanceof PluginError ? error.message : 'manifest.json is missing'); }
  const raw = BUFFER_TO_STRING(manifest, 'utf8');
  if (sha256(raw) !== expectedDigest) return drift('manifest.json digest differs from the lockfile');
  let entries: { path: string; sha256: string; bytes: number }[];
  try { entries = JSON_PARSE(raw); if (!ARRAY_IS_ARRAY(entries)) throw new Error(); }
  catch { return drift('manifest.json is not a manifest'); }
  if (entries.length > MAX_PLUGIN_FILES) return drift(`manifest.json lists more than ${MAX_PLUGIN_FILES} files`);
  const paths = new SET<string>();
  const files = [{ path: 'manifest.json', data: manifest }];
  let totalBytes = 0;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index]!;
    if (typeof entry?.path !== 'string' || !safePath(entry.path)
      || typeof entry.sha256 !== 'string' || !REGEXP_TEST(/^[a-f0-9]{64}$/, entry.sha256)
      || !NUMBER_IS_SAFE_INTEGER(entry.bytes) || entry.bytes < 0 || entry.bytes > MAX_PLUGIN_FILE_BYTES
      || SET_HAS(paths, entry.path)) return drift('manifest.json lists an invalid file');
    totalBytes += entry.bytes;
    if (totalBytes > MAX_PLUGIN_TOTAL_BYTES) return drift(`plugin exceeds ${MAX_PLUGIN_TOTAL_BYTES} bytes`);
    let data: Buffer;
    try { data = await regularFile(directory, entry.path, MAX_PLUGIN_FILE_BYTES, entry.bytes, hooks); }
    catch (error) { return drift(error instanceof PluginError ? error.message : `${entry.path} is missing`); }
    if (sha256(data) !== entry.sha256) return drift(`${entry.path} changed since installation`);
    SET_ADD(paths, entry.path);
    files[files.length] = { path: entry.path, data };
  }
  SET_ADD(paths, 'manifest.json');
  await rejectExtras(directory, '', paths, drift);
  const frozen: Readonly<{ path: string; data: Buffer }>[] = [];
  for (let index = 0; index < files.length; index += 1) {
    frozen[index] = OBJECT_FREEZE(files[index]!);
  }
  return OBJECT_FREEZE(frozen);
}

/** Re-verify, then return every stored file including the payload `manifest.json`. */
export async function readStoredPluginFiles(
  directory: string,
  expectedDigest: string,
  hooks: StoredPluginReadTestHooks = {},
): Promise<readonly { path: string; data: Buffer }[]> {
  return await readVerifiedStoredPluginFiles(directory, expectedDigest, hooks);
}

/** Drop a materialized plugin directory. Missing is a no-op. */
export async function removeStoredPlugin(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

async function rejectExtras(root: string, prefix: string, paths: Set<string>, drift: (m: string) => never): Promise<void> {
  let entries = 0;
  async function visit(currentPrefix: string): Promise<void> {
    const directory = await opendir(join(root, currentPrefix));
    for await (const entry of directory) {
      entries += 1;
      if (entries > MAX_PLUGIN_STORE_ENTRIES) drift('plugin store contains too many entries');
      const path = currentPrefix + entry.name;
      let declaredDescendant = false;
      SET_FOR_EACH(paths, file => {
        if (STRING_STARTS_WITH(file, `${path}/`)) declaredDescendant = true;
      });
      if (entry.isDirectory() && declaredDescendant) await visit(`${path}/`);
      else if (!entry.isFile() || !SET_HAS(paths, path)) drift(`${path}: unlisted file or unsupported file type`);
    }
  }
  await visit(prefix);
}
