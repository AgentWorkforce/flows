import { readFile, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BundleFile } from './bundle.js';
import { safePath, sha256 } from './bundle.js';
import { findPluginProject } from './plugin-loader.js';
import { parsePluginLock, readPluginLock, reconcileDeclaredExtensions, type PluginLock } from './plugin-lock.js';
import { PluginError } from './plugin-manifest.js';
import { pluginStoreDirectory, readStoredPluginFiles, verifyStoredPlugin } from './plugin-store.js';

const EMPTY_LOCK: PluginLock = Object.freeze({ version: 2, plugins: Object.freeze([]) });

/**
 * Plugin provenance and bytes to put in a sealed bundle: `lockfile.json` is
 * the same v2 lock the project records, and each extension's materialized
 * files land under `plugins/<name>/…`. No project / no github: plugins →
 * `{ version: 2, plugins: [] }` and no files. Fail closed on lock/store drift.
 */
export async function collectBundleExtensions(flowPath: string): Promise<{ lock: PluginLock; files: BundleFile[] }> {
  const root = findPluginProject(dirname(flowPath));
  if (root === undefined) return { lock: EMPTY_LOCK, files: [] };
  const locked = reconcileDeclaredExtensions(root);
  const files: BundleFile[] = [];
  for (const { entry } of locked) {
    const stored = await readStoredPluginFiles(pluginStoreDirectory(root, entry.name, entry.digest), entry.digest);
    for (const file of stored) files.push({ path: `plugins/${entry.name}/${file.path}`, data: file.data });
  }
  return { lock: readPluginLock(root), files };
}

/**
 * After `verifyBundle` has hashed every payload file, check that `lockfile.json`
 * is a v2 plugin lock (or a legacy v1 `{version:1, adapters}` with no plugins)
 * and that each locked extension's store digest matches `plugins/<name>/manifest.json`.
 */
export async function verifyBundlePluginLock(bundle: string): Promise<void> {
  let parsed: unknown;
  try { parsed = JSON.parse(await readFile(join(bundle, 'lockfile.json'), 'utf8')); }
  catch { throw new Error('lockfile.json: not valid JSON'); }
  if (isLegacyV1Lock(parsed) || isLegacyNpmLock(parsed)) {
    await assertNoLegacyPluginPayload(bundle);
    return;
  }
  let lock: PluginLock;
  try { lock = parsePluginLock(parsed); }
  catch (error) {
    throw new Error(error instanceof PluginError ? error.message : 'lockfile.json: not a plugin lock');
  }
  for (const entry of lock.plugins) {
    if (!safePath(entry.name) || entry.name.includes('/')) {
      throw new Error(`lockfile.json: plugin name ${entry.name} is not a safe path component`);
    }
    const directory = join(bundle, 'plugins', entry.name);
    await verifyStoredPlugin(directory, entry.digest);
    let pluginManifest: Buffer;
    try { pluginManifest = await readFile(join(directory, 'flows-plugin.json')); }
    catch { throw new Error(`lockfile.json: plugin ${entry.name} is missing plugins/${entry.name}/flows-plugin.json`); }
    if (sha256(pluginManifest) !== entry.manifestSha256) {
      throw new Error(`lockfile.json: plugin ${entry.name} flows-plugin.json does not match the lockfile manifest hash`);
    }
  }
}

async function assertNoLegacyPluginPayload(bundle: string): Promise<void> {
  let entries: string[];
  try { entries = await readdir(join(bundle, 'plugins')); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (entries.length > 0) {
    throw new Error('lockfile.json: legacy locks cannot authenticate plugins/ payloads');
  }
}

function isLegacyV1Lock(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as { version?: unknown }).version === 1
    && Array.isArray((value as { adapters?: unknown }).adapters);
}

function isLegacyNpmLock(value: unknown): boolean {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const lock = value as { lockfileVersion?: unknown; packages?: unknown };
  return (lock.lockfileVersion === 2 || lock.lockfileVersion === 3) && typeof lock.packages === 'object' && lock.packages !== null;
}
