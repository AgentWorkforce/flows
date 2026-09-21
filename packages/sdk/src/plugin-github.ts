import { payloadManifest, safePath, sha256 } from './bundle.js';
import { PluginError } from './plugin-manifest.js';
import { SHA, type PluginSourceInput, type PluginSourceRef } from './plugin-source.js';

/**
 * Public, unauthenticated GitHub reads for flow-extension plugins — the same
 * posture as Cloud's deploy links: no credential ever travels to GitHub, so a
 * private repository simply answers 404 and is reported as unresolved.
 *
 * Two calls resolve a ref and enumerate a tree; blobs come from
 * raw.githubusercontent.com pinned to the resolved commit. Every byte count is
 * checked against the tree listing, and the tree is refused if GitHub
 * truncated it, if it contains a symlink or submodule under the plugin path,
 * or if any file or the whole plugin exceeds the bounds below.
 */
export type FetchLike = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) => Promise<Response>;

export const MAX_PLUGIN_FILE_BYTES = 256_000;
export const MAX_PLUGIN_TOTAL_BYTES = 2_000_000;
export const MAX_PLUGIN_FILES = 500;
const TIMEOUT_MS = 15_000;
const API = 'https://api.github.com';
const RAW = 'https://raw.githubusercontent.com';

export interface FetchedPluginFile { readonly path: string; readonly data: Buffer }
export interface FetchedPlugin {
  readonly source: PluginSourceRef;
  /** Plugin-relative paths, sorted. */
  readonly files: readonly FetchedPluginFile[];
  /** sha256 of `payloadManifest(files)`: the content identity persisted as `@sha256:`. */
  readonly digest: string;
}

async function request(fetch: FetchLike, url: string, accept: string): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { headers: { accept, 'user-agent': 'relayflows-sdk' }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (error) {
    throw new PluginError('plugin_fetch_failed', `GitHub request failed: ${url} (${error instanceof Error ? error.message : String(error)}).`);
  }
  if (response.status === 404) throw new PluginError('plugin_source_unresolved', `Not found on GitHub (or not public): ${url}.`);
  if (!response.ok) throw new PluginError('plugin_fetch_failed', `GitHub answered ${response.status} for ${url}.`);
  return response;
}

/** Branch, tag, or commit → the commit sha it names right now; a sha input is verified to exist. */
export async function resolveGithubSha(source: PluginSourceInput, fetch: FetchLike = globalThis.fetch): Promise<PluginSourceRef> {
  const url = `${API}/repos/${source.owner}/${source.repo}/commits/${encodeURIComponent(source.ref)}`;
  const sha = (await (await request(fetch, url, 'application/vnd.github.sha')).text()).trim();
  if (!SHA.test(sha)) throw new PluginError('plugin_fetch_failed', `GitHub returned a malformed commit sha for ${source.ref}.`);
  if (SHA.test(source.ref) && sha !== source.ref) throw new PluginError('plugin_source_unresolved', `Commit ${source.ref} resolved to ${sha}.`);
  return Object.freeze({ ...source, sha });
}

interface TreeEntry { path: string; mode: string; type: string; size?: number }

async function listTree(source: PluginSourceRef, fetch: FetchLike): Promise<TreeEntry[]> {
  const url = `${API}/repos/${source.owner}/${source.repo}/git/trees/${source.sha}?recursive=1`;
  let body: unknown;
  try { body = await (await request(fetch, url, 'application/vnd.github+json')).json(); }
  catch { throw new PluginError('plugin_fetch_failed', 'GitHub tree listing is not JSON.'); }
  const tree = typeof body === 'object' && body !== null ? (body as { tree?: unknown; truncated?: unknown }) : {};
  if (tree.truncated === true) throw new PluginError('plugin_fetch_failed', 'GitHub truncated the tree listing; the repository is too large to enumerate safely.');
  if (!Array.isArray(tree.tree)) throw new PluginError('plugin_fetch_failed', 'GitHub tree listing has no entries.');
  return tree.tree.filter((e): e is TreeEntry => typeof e === 'object' && e !== null
    && typeof (e as TreeEntry).path === 'string' && typeof (e as TreeEntry).mode === 'string' && typeof (e as TreeEntry).type === 'string');
}

/** Enumerate and download the plugin directory at the pinned commit, bounded and verified. */
export async function fetchGithubPlugin(source: PluginSourceRef, fetch: FetchLike = globalThis.fetch): Promise<FetchedPlugin> {
  const prefix = source.path === '' ? '' : `${source.path}/`;
  const entries = (await listTree(source, fetch)).filter(e => e.path.startsWith(prefix));
  if (source.path !== '' && entries.length === 0) throw new PluginError('plugin_source_unresolved', `${source.path} does not exist at ${source.sha}.`);
  const blobs: { path: string; size: number }[] = [];
  let total = 0;
  for (const entry of entries) {
    const relative = entry.path.slice(prefix.length);
    if (entry.type === 'tree') continue;
    if (entry.type === 'commit') throw new PluginError('plugin_path_invalid', `${entry.path} is a submodule; plugins must be plain files.`);
    if (entry.mode === '120000') throw new PluginError('plugin_path_invalid', `${entry.path} is a symlink; plugins must be plain files.`);
    if (entry.type !== 'blob' || !safePath(relative)) throw new PluginError('plugin_path_invalid', `${entry.path} is not a plain repository file.`);
    if (!Number.isSafeInteger(entry.size) || entry.size! < 0) throw new PluginError('plugin_fetch_failed', `${entry.path} has no size in the tree listing.`);
    if (entry.size! > MAX_PLUGIN_FILE_BYTES) throw new PluginError('plugin_too_large', `${entry.path} is ${entry.size} bytes; the limit is ${MAX_PLUGIN_FILE_BYTES}.`);
    total += entry.size!;
    if (total > MAX_PLUGIN_TOTAL_BYTES) throw new PluginError('plugin_too_large', `Plugin exceeds ${MAX_PLUGIN_TOTAL_BYTES} bytes in total.`);
    blobs.push({ path: relative, size: entry.size! });
    if (blobs.length > MAX_PLUGIN_FILES) throw new PluginError('plugin_too_large', `Plugin has more than ${MAX_PLUGIN_FILES} files.`);
  }
  if (!blobs.some(b => b.path === 'flows-plugin.json')) throw new PluginError('plugin_manifest_missing', `${source.owner}/${source.repo}@${source.sha}${prefix === '' ? '' : `#${source.path}`} has no flows-plugin.json.`);
  const files: FetchedPluginFile[] = [];
  for (const blob of blobs.sort((a, b) => a.path < b.path ? -1 : 1)) {
    const url = `${RAW}/${source.owner}/${source.repo}/${source.sha}/${prefix}${blob.path}`;
    const data = Buffer.from(await (await request(fetch, url, 'application/octet-stream')).arrayBuffer());
    if (data.length !== blob.size) throw new PluginError('plugin_source_drift', `${blob.path}: fetched ${data.length} bytes, tree lists ${blob.size}.`);
    files.push(Object.freeze({ path: blob.path, data }));
  }
  return Object.freeze({ source, files: Object.freeze(files), digest: sha256(payloadManifest(files)) });
}
