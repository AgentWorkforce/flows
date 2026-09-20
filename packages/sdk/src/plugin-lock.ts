import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PluginError } from './plugin-manifest.js';
import { SHA, canonicalPluginRef, isGithubPluginRef, parseCanonicalPluginRef, type PluginSourceRef } from './plugin-source.js';

/**
 * `flows.lock.json` — the project's plugin provenance. `flows.json.plugins`
 * says *what* is declared; the lockfile says exactly which bytes that meant:
 * the commit, the content digest, the manifest hash, and the order the
 * operator declared. Version 2 because the sealed bundle's `lockfile.json`
 * is version 1 and the two will converge on this shape when bundles carry
 * plugins (RFC-0001 decision 14).
 */
export const PLUGIN_LOCK_FILE = 'flows.lock.json';
export const PLUGIN_LOCK_VERSION = 2;

export interface PluginLockEntry {
  readonly name: string;
  readonly kind: 'flow-extension';
  readonly version: string;
  readonly source: { readonly host: 'github'; readonly owner: string; readonly repo: string; readonly sha: string; readonly path: string };
  /** sha256 of the payload manifest — the `@sha256:` in `.flows/plugins`. */
  readonly digest: string;
  /** sha256 of the `flows-plugin.json` bytes as installed. */
  readonly manifestSha256: string;
  /**
   * 1-based position among the flow-extension (`github:`) entries of
   * `flows.json.plugins`, in declaration order. Helper entries interspersed in
   * that list do not count, so the order is the composition order exactly.
   */
  readonly order: number;
  readonly resolvedAt: string;
}
export interface PluginLock { readonly version: 2; readonly plugins: readonly PluginLockEntry[] }

const HEX64 = /^[0-9a-f]{64}$/;
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const invalid = (message: string): never => { throw new PluginError('plugin_lock_invalid', `${PLUGIN_LOCK_FILE}: ${message}`); };

export function parsePluginLock(input: unknown): PluginLock {
  if (!object(input) || input.version !== PLUGIN_LOCK_VERSION || !Array.isArray(input.plugins)
    || Object.keys(input).some(k => !['version', 'plugins'].includes(k))) return invalid(`expected { version: ${PLUGIN_LOCK_VERSION}, plugins: [] }.`);
  const names = new Set<string>();
  const plugins = input.plugins.map((entry, index) => {
    if (!object(entry) || Object.keys(entry).sort().join(',') !== 'digest,kind,manifestSha256,name,order,resolvedAt,source,version'
      || entry.kind !== 'flow-extension' || typeof entry.name !== 'string' || typeof entry.version !== 'string'
      || typeof entry.digest !== 'string' || !HEX64.test(entry.digest)
      || typeof entry.manifestSha256 !== 'string' || !HEX64.test(entry.manifestSha256)
      || entry.order !== index + 1 || typeof entry.resolvedAt !== 'string' || Number.isNaN(Date.parse(entry.resolvedAt))
      || !object(entry.source) || entry.source.host !== 'github' || typeof entry.source.owner !== 'string'
      || typeof entry.source.repo !== 'string' || typeof entry.source.sha !== 'string' || !SHA.test(entry.source.sha)
      || typeof entry.source.path !== 'string') return invalid(`plugins[${index}] is malformed.`);
    if (names.has(entry.name)) return invalid(`plugin ${entry.name} is listed twice.`);
    names.add(entry.name);
    const source = parseCanonicalPluginRef(canonicalPluginRef({ host: 'github', owner: entry.source.owner, repo: entry.source.repo, ref: entry.source.sha, sha: entry.source.sha, path: entry.source.path }));
    return Object.freeze({
      name: entry.name, kind: 'flow-extension' as const, version: entry.version,
      source: Object.freeze({ host: 'github' as const, owner: source.owner, repo: source.repo, sha: source.sha, path: source.path }),
      digest: entry.digest, manifestSha256: entry.manifestSha256, order: entry.order, resolvedAt: entry.resolvedAt,
    });
  });
  return Object.freeze({ version: PLUGIN_LOCK_VERSION, plugins: Object.freeze(plugins) });
}

/** Absent file → empty lock; unreadable or malformed → refusal. */
export function readPluginLock(root: string): PluginLock {
  const path = join(root, PLUGIN_LOCK_FILE);
  if (!existsSync(path)) return Object.freeze({ version: PLUGIN_LOCK_VERSION, plugins: Object.freeze([]) });
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { return invalid('not valid JSON.'); }
  return parsePluginLock(parsed);
}

export function writePluginLock(root: string, lock: PluginLock): void {
  writeFileSync(join(root, PLUGIN_LOCK_FILE), `${JSON.stringify(parsePluginLock(lock), null, 2)}\n`);
}

/**
 * Rebuild the entry list in `flows.json.plugins` order: `order` is derived from
 * the declaration list, never stored independently, so the two cannot disagree.
 * Lock entries that are no longer declared are dropped; a declaration with no
 * matching lock entry is a refusal.
 */
export function lockForDeclared(lock: PluginLock, declared: readonly string[]): PluginLock {
  const byRef = new Map(lock.plugins.map(p => [canonicalPluginRef({ ...p.source, ref: p.source.sha }), p]));
  const plugins = declared.filter(isGithubPluginRef).map((ref, index) => {
    const found = byRef.get(ref);
    if (found === undefined) return invalid(`flows.json declares ${ref} but the lockfile has no entry for it; run flows add ${ref}.`);
    return Object.freeze({ ...found, order: index + 1 });
  });
  return Object.freeze({ version: PLUGIN_LOCK_VERSION, plugins: Object.freeze(plugins) });
}

export function lockWithPlugin(
  lock: PluginLock, declared: readonly string[],
  entry: Omit<PluginLockEntry, 'kind' | 'order'>,
): PluginLock {
  const byRef = new Map(lock.plugins.map(p => [canonicalPluginRef({ ...p.source, ref: p.source.sha }), p]));
  byRef.set(canonicalPluginRef({ ...entry.source, ref: entry.source.sha }), { ...entry, kind: 'flow-extension', order: 0 });
  return lockForDeclared({ version: PLUGIN_LOCK_VERSION, plugins: Object.freeze([...byRef.values()]) }, declared);
}

/** Lock entries paired with their declared reference, in declaration order. */
export function lockedPlugins(lock: PluginLock): readonly { ref: string; entry: PluginLockEntry; source: PluginSourceRef }[] {
  return lock.plugins.map(entry => {
    const source = { ...entry.source, ref: entry.source.sha };
    return { ref: canonicalPluginRef(source), entry, source };
  });
}

/** The `github:` entries of `flows.json.plugins`, in declaration order; helper entries are left out. */
export function declaredExtensionRefs(root: string): readonly string[] {
  let config: { plugins?: unknown };
  try { config = JSON.parse(readFileSync(join(root, 'flows.json'), 'utf8')); }
  catch { throw new PluginError('plugin_manifest_invalid', 'Invalid flows.json.'); }
  if (config === null || typeof config !== 'object' || (config.plugins !== undefined && (!Array.isArray(config.plugins) || !config.plugins.every(p => typeof p === 'string')))) {
    throw new PluginError('plugin_manifest_invalid', 'flows.json plugins must be strings.');
  }
  return Object.freeze(((config.plugins as string[] | undefined) ?? []).filter(isGithubPluginRef));
}

/**
 * The three records that must agree before an extension is trusted:
 * `flows.json.plugins` (declaration), `flows.lock.json` (provenance), and —
 * checked by the caller against the returned digests — `.flows/plugins`
 * (bytes). Any declaration without a lock entry, lock entry without a
 * declaration, or order disagreement is `plugin_lock_invalid`.
 */
export function reconcileDeclaredExtensions(root: string): readonly { ref: string; entry: PluginLockEntry; source: PluginSourceRef }[] {
  const declared = declaredExtensionRefs(root);
  const locked = lockedPlugins(readPluginLock(root));
  const lockedRefs = locked.map(p => p.ref);
  for (const ref of declared) if (!lockedRefs.includes(ref)) throw new PluginError('plugin_lock_invalid', `flows.json declares ${ref} but flows.lock.json has no entry for it.`);
  for (const ref of lockedRefs) if (!declared.includes(ref)) throw new PluginError('plugin_lock_invalid', `flows.lock.json records ${ref} but flows.json does not declare it.`);
  if (declared.some((ref, index) => lockedRefs[index] !== ref)) throw new PluginError('plugin_lock_invalid', 'flows.lock.json order differs from flows.json.plugins.');
  return locked;
}
