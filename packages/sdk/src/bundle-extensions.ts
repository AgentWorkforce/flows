import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { BundleFile } from './bundle.js';
import { sha256 } from './bundle.js';
import { findPluginProject } from './plugin-loader.js';
import { parsePluginLock, readPluginLock, reconcileDeclaredExtensions, type PluginLock } from './plugin-lock.js';
import { PluginError } from './plugin-manifest.js';
import { pluginStoreDirectory, readStoredPluginFiles } from './plugin-store.js';

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
  if (isLegacyV1Lock(parsed)) return;
  let lock: PluginLock;
  try { lock = parsePluginLock(parsed); }
  catch (error) {
    throw new Error(error instanceof PluginError ? error.message : 'lockfile.json: not a plugin lock');
  }
  for (const entry of lock.plugins) {
    let manifest: Buffer;
    try { manifest = await readFile(join(bundle, 'plugins', entry.name, 'manifest.json')); }
    catch { throw new Error(`lockfile.json: plugin ${entry.name} is missing plugins/${entry.name}/manifest.json`); }
    if (sha256(manifest) !== entry.digest) {
      throw new Error(`lockfile.json: plugin ${entry.name} digest does not match plugins/${entry.name}/manifest.json`);
    }
  }
}

function isLegacyV1Lock(value: unknown): boolean {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && (value as { version?: unknown }).version === 1
    && Array.isArray((value as { adapters?: unknown }).adapters);
}
