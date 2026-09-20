import { lstat, mkdir, mkdtemp, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { payloadManifest, safePath, sha256 } from './bundle.js';
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

export function pluginStoreDirectory(root: string, name: string, digest: string): string {
  return join(resolve(root), PLUGIN_STORE, `${name}@sha256:${digest}`);
}

export interface StoredPluginFile { readonly path: string; readonly data: Uint8Array }

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
    for (const file of files) {
      if (!safePath(file.path) || file.path === 'manifest.json') throw new PluginError('plugin_path_invalid', `${file.path}: invalid plugin path.`);
      await mkdir(dirname(join(staging, file.path)), { recursive: true });
      await writeFile(join(staging, file.path), file.data, { mode: 0o644 });
    }
    await writeFile(join(staging, 'manifest.json'), manifest);
    try { await rename(staging, directory); }
    catch (error) {
      if (!['EEXIST', 'ENOTEMPTY'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      await verifyStoredPlugin(directory, digest);
    }
  } finally { await rm(staging, { recursive: true, force: true }); }
  return { directory, digest };
}

async function regularFile(root: string, path: string): Promise<Buffer> {
  const parts = path.split('/');
  for (let i = 1; i <= parts.length; i++) {
    const stat = await lstat(join(root, ...parts.slice(0, i)));
    if (i === parts.length ? !stat.isFile() : !stat.isDirectory()) throw new PluginError('plugin_source_drift', `${path}: expected a regular file, without symlinks.`);
  }
  return readFile(join(root, path));
}

/** Re-hash a materialized plugin and compare with the digest the lockfile recorded. */
export async function verifyStoredPlugin(directory: string, expectedDigest: string): Promise<void> {
  const drift = (message: string): never => { throw new PluginError('plugin_source_drift', `${directory}: ${message}`); };
  let raw: string;
  try {
    if (!(await lstat(directory)).isDirectory()) return drift('not a directory');
    raw = (await regularFile(directory, 'manifest.json')).toString('utf8');
  } catch (error) { return drift(error instanceof PluginError ? error.message : 'manifest.json is missing'); }
  if (sha256(raw) !== expectedDigest) return drift('manifest.json digest differs from the lockfile');
  let entries: { path: string; sha256: string; bytes: number }[];
  try { entries = JSON.parse(raw); if (!Array.isArray(entries)) throw new Error(); }
  catch { return drift('manifest.json is not a manifest'); }
  const paths = new Set<string>();
  for (const entry of entries) {
    if (typeof entry?.path !== 'string' || !safePath(entry.path)) return drift('manifest.json lists an invalid path');
    let data: Buffer;
    try { data = await regularFile(directory, entry.path); }
    catch (error) { return drift(error instanceof PluginError ? error.message : `${entry.path} is missing`); }
    if (data.length !== entry.bytes || sha256(data) !== entry.sha256) return drift(`${entry.path} changed since installation`);
    paths.add(entry.path);
  }
  await rejectExtras(directory, '', new Set([...paths, 'manifest.json']), drift);
}

async function rejectExtras(root: string, prefix: string, paths: Set<string>, drift: (m: string) => never): Promise<void> {
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const path = prefix + entry.name;
    if (entry.isDirectory() && [...paths].some(file => file.startsWith(`${path}/`))) await rejectExtras(root, `${path}/`, paths, drift);
    else if (!entry.isFile() || !paths.has(path)) drift(`${path}: unlisted file or unsupported file type`);
  }
}
