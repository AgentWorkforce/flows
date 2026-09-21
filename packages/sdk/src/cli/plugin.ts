import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CliIo } from '../cli.js';
import { diffExtension, extensionManifestOf } from './add-extension.js';
import { assertCompatible, runtimeVersions, type RuntimeVersions } from '../flow-extension-compat.js';
import { validateFlowExtensionManifest, type FlowExtensionManifest } from '../flow-extension-manifest.js';
import { fetchGithubPlugin, resolveGithubSha, type FetchLike } from '../plugin-github.js';
import {
  PLUGIN_LOCK_FILE, lockForDeclared, lockWithPlugin, lockedPlugins, readPluginLock, reconcileDeclaredExtensions,
  writeFlowsAndLock, type PluginLock, type PluginLockEntry,
} from '../plugin-lock.js';
import { findPluginProject } from '../plugin-loader.js';
import { PluginError } from '../plugin-manifest.js';
import { canonicalPluginRef, parsePluginSource } from '../plugin-source.js';
import { materializePlugin, pluginStoreDirectory, removeStoredPlugin, verifyStoredPlugin } from '../plugin-store.js';

export type PluginArgs =
  | { command: 'plugin'; sub: 'list'; json: boolean }
  | { command: 'plugin'; sub: 'verify'; json: boolean; offline: boolean }
  | { command: 'plugin'; sub: 'remove'; json: boolean; name: string }
  | { command: 'plugin'; sub: 'update'; json: boolean; yes: boolean; name: string | undefined; to: string | undefined };

/** `flows plugin list|verify|remove|update` */
export function parsePluginArgs(args: readonly string[]): PluginArgs | undefined {
  const [sub, ...rest] = args;
  if (sub === 'list' || sub === 'verify') {
    let json = false;
    let offline = false;
    for (const arg of rest) {
      if (arg === '--json' && !json) json = true;
      else if (arg === '--offline' && !offline && sub === 'verify') offline = true;
      else return undefined;
    }
    return sub === 'list' ? { command: 'plugin', sub, json } : { command: 'plugin', sub, json, offline };
  }
  if (sub === 'remove') {
    let json = false;
    let name: string | undefined;
    for (const arg of rest) {
      if (arg === '--json' && !json) json = true;
      else if (arg.startsWith('-') || name !== undefined) return undefined;
      else name = arg;
    }
    return name === undefined ? undefined : { command: 'plugin', sub: 'remove', json, name };
  }
  if (sub !== 'update') return undefined;
  let json = false;
  let yes = false;
  let to: string | undefined;
  let name: string | undefined;
  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i]!;
    if (arg === '--json' && !json) json = true;
    else if (arg === '--yes' && !yes) yes = true;
    else if (arg === '--to') {
      const value = rest[i + 1];
      if (to !== undefined || value === undefined || value.startsWith('-')) return undefined;
      to = value;
      i += 1;
    } else if (arg.startsWith('-') || name !== undefined) return undefined;
    else name = arg;
  }
  return { command: 'plugin', sub: 'update', json, yes, name, to };
}

/**
 * Cross-check the three records that must agree: `flows.json.plugins`
 * (declaration), `flows.lock.json` (provenance), and `.flows/plugins` (bytes).
 * With the network, the pinned commit is re-fetched and re-hashed too.
 */
export async function verifyPlugins(root: string, options: { offline: boolean; fetch?: FetchLike }): Promise<{ entry: PluginLockEntry; ref: string; directory: string; remote: 'verified' | 'skipped' }[]> {
  const results = [];
  for (const { ref, entry, source } of reconcileDeclaredExtensions(root)) {
    const directory = pluginStoreDirectory(root, entry.name, entry.digest);
    await verifyStoredPlugin(directory, entry.digest);
    let remote: 'verified' | 'skipped' = 'skipped';
    if (!options.offline) {
      const fetched = await fetchGithubPlugin(source, options.fetch);
      if (fetched.digest !== entry.digest) throw new PluginError('plugin_source_drift', `${ref}: GitHub now serves digest ${fetched.digest}, lockfile has ${entry.digest}.`);
      remote = 'verified';
    }
    results.push({ entry, ref, directory, remote });
  }
  return results;
}

export interface PluginCommandOptions {
  cwd?: string;
  fetch?: FetchLike;
  now?: () => Date;
  versions?: RuntimeVersions;
}

export async function runPluginCommand(parsed: PluginArgs, io: CliIo, options: PluginCommandOptions = {}): Promise<0 | 2> {
  try {
    const root = findPluginProject(options.cwd ?? process.cwd());
    if (!root) throw new PluginError('plugin_manifest_invalid', 'flows plugin requires a project with flows.json.');
    if (parsed.sub === 'list') {
      const plugins = lockedPlugins(readPluginLock(root));
      if (parsed.json) { io.stdout(JSON.stringify({ plugins: plugins.map(p => ({ ...p.entry, ref: p.ref })) })); return 0; }
      if (plugins.length === 0) { io.stdout('No flow-extension plugins installed.'); return 0; }
      for (const { entry, ref } of plugins) io.stdout(`${entry.order}. ${entry.name}@${entry.version}  ${ref}  sha256:${entry.digest}`);
      return 0;
    }
    if (parsed.sub === 'verify') {
      const results = await verifyPlugins(root, { offline: parsed.offline, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
      if (parsed.json) { io.stdout(JSON.stringify({ ok: true, plugins: results.map(r => ({ name: r.entry.name, ref: r.ref, digest: r.entry.digest, remote: r.remote })) })); return 0; }
      for (const r of results) io.stdout(`OK ${r.entry.name}@${r.entry.version}  ${r.ref}  local digest matches lockfile; remote ${r.remote}`);
      if (results.length === 0) io.stdout('No flow-extension plugins to verify.');
      return 0;
    }
    if (parsed.sub === 'remove') return await removePlugin(root, parsed, io);
    return await updatePlugins(root, parsed, io, options);
  } catch (error) {
    const refusal = error instanceof PluginError ? error : new PluginError('plugin_manifest_invalid', (error as Error).message);
    if (parsed.json) io.stdout(JSON.stringify({ ok: false, code: refusal.code, message: refusal.message }));
    io.stderr(`REFUSED [${refusal.code}] ${refusal.message}`);
    return 2;
  }
}

function readFlowsConfig(root: string): { path: string; config: Record<string, unknown>; plugins: string[] } {
  const path = join(root, 'flows.json');
  let parsed: unknown;
  try { parsed = JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new PluginError('plugin_manifest_invalid', 'Invalid flows.json.'); }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)
    || ((parsed as { plugins?: unknown }).plugins !== undefined
      && (!Array.isArray((parsed as { plugins?: unknown }).plugins)
        || !(parsed as { plugins: unknown[] }).plugins.every(p => typeof p === 'string')))) {
    throw new PluginError('plugin_manifest_invalid', 'Invalid flows.json plugins list.');
  }
  const config = parsed as Record<string, unknown>;
  return { path, config, plugins: [...((config.plugins as string[] | undefined) ?? [])] };
}

function storedManifest(directory: string): FlowExtensionManifest {
  let raw: string;
  try { raw = readFileSync(join(directory, 'flows-plugin.json'), 'utf8'); }
  catch { throw new PluginError('plugin_source_drift', `${directory}: flows-plugin.json is missing.`); }
  let input: unknown;
  try { input = JSON.parse(raw); }
  catch { throw new PluginError('plugin_manifest_invalid', `${directory}: flows-plugin.json is unreadable or invalid JSON.`); }
  return validateFlowExtensionManifest(input);
}

function storeReferenced(lock: PluginLock, name: string, digest: string): boolean {
  return lock.plugins.some(p => p.name === name && p.digest === digest);
}

async function dropUnreferencedStore(root: string, name: string, digest: string, lock: PluginLock): Promise<void> {
  if (storeReferenced(lock, name, digest)) return;
  await removeStoredPlugin(pluginStoreDirectory(root, name, digest));
}

async function removePlugin(root: string, parsed: Extract<PluginArgs, { sub: 'remove' }>, io: CliIo): Promise<0 | 2> {
  const locked = lockedPlugins(readPluginLock(root));
  const match = locked.find(p => p.entry.name === parsed.name);
  if (match === undefined) throw new PluginError('plugin_manifest_invalid', `No flow-extension plugin named ${parsed.name}.`);
  const { path, config, plugins } = readFlowsConfig(root);
  const nextDeclared = plugins.filter(ref => ref !== match.ref);
  const nextLock = lockForDeclared(readPluginLock(root), nextDeclared);
  writeFlowsAndLock(root, path, config, nextDeclared, nextLock);
  await dropUnreferencedStore(root, match.entry.name, match.entry.digest, nextLock);
  if (parsed.json) {
    io.stdout(JSON.stringify({ ok: true, removed: { name: match.entry.name, ref: match.ref, digest: match.entry.digest } }));
    return 0;
  }
  io.stdout(`Removed ${match.entry.name}@${match.entry.version}  ${match.ref}`);
  return 0;
}

function replaceDeclaredRef(plugins: readonly string[], oldRef: string, newRef: string): string[] {
  const without = plugins.filter(ref => ref !== oldRef);
  if (without.includes(newRef)) return without;
  const at = plugins.indexOf(oldRef);
  const next = [...without];
  next.splice(at === -1 ? next.length : at, 0, newRef);
  return next;
}

async function updatePlugins(
  root: string,
  parsed: Extract<PluginArgs, { sub: 'update' }>,
  io: CliIo,
  options: PluginCommandOptions,
): Promise<0 | 2> {
  if (parsed.to !== undefined && parsed.name === undefined) {
    throw new PluginError('plugin_manifest_invalid', 'flows plugin update --to requires a plugin name.');
  }
  const locked = lockedPlugins(readPluginLock(root));
  const targets = parsed.name === undefined ? locked : locked.filter(p => p.entry.name === parsed.name);
  if (parsed.name !== undefined && targets.length === 0) {
    throw new PluginError('plugin_manifest_invalid', `No flow-extension plugin named ${parsed.name}.`);
  }
  if (targets.length === 0) {
    if (parsed.json) { io.stdout(JSON.stringify({ ok: true, plugins: [] })); return 0; }
    io.stdout('No flow-extension plugins to update.');
    return 0;
  }

  type Plan = {
    current: (typeof locked)[number];
    ref: string;
    digest: string;
    manifest: FlowExtensionManifest;
    manifestSha256: string;
    source: { host: 'github'; owner: string; repo: string; sha: string; path: string };
    files: readonly { path: string; data: Uint8Array }[];
    diff: string[];
    changed: boolean;
  };
  const plans: Plan[] = [];
  for (const current of targets) {
    const requested = parsed.to === undefined ? { ...current.source } : parsePluginSource(parsed.to);
    const source = await resolveGithubSha(requested, options.fetch);
    const fetched = await fetchGithubPlugin(source, options.fetch);
    const { manifest, manifestSha256 } = extensionManifestOf(fetched);
    if (manifest.name !== current.entry.name) {
      throw new PluginError('plugin_manifest_invalid', `Update of ${current.entry.name} resolved to plugin ${manifest.name}; remove it and add the new name instead.`);
    }
    assertCompatible(manifest, options.versions ?? runtimeVersions());
    const directory = pluginStoreDirectory(root, current.entry.name, current.entry.digest);
    const before = storedManifest(directory);
    const ref = canonicalPluginRef(source);
    const changed = ref !== current.ref || fetched.digest !== current.entry.digest || manifestSha256 !== current.entry.manifestSha256;
    plans.push({
      current, ref, digest: fetched.digest, manifest, manifestSha256,
      source: { host: 'github', owner: source.owner, repo: source.repo, sha: source.sha, path: source.path },
      files: fetched.files, diff: diffExtension(before, manifest), changed,
    });
  }

  const pending = plans.filter(p => p.changed);
  const summary = plans.map(p => ({
    name: p.current.entry.name, from: p.current.ref, to: p.ref, digest: p.digest, changed: p.changed, diff: p.diff,
  }));
  if (!parsed.json) {
    for (const plan of plans) {
      if (!plan.changed) {
        io.stdout(`${plan.current.entry.name} is already at ${plan.ref}  sha256:${plan.digest}`);
        continue;
      }
      io.stdout(`Update ${plan.current.entry.name}  ${plan.current.ref} → ${plan.ref}`);
      io.stdout(`  digest sha256:${plan.current.entry.digest} → sha256:${plan.digest}`);
      for (const line of plan.diff) io.stdout(line);
    }
  }
  if (pending.length === 0) {
    if (parsed.json) io.stdout(JSON.stringify({ ok: true, plugins: summary }));
    return 0;
  }
  if (!parsed.yes) {
    if (parsed.json) {
      io.stdout(JSON.stringify({
        ok: false, applied: false, code: 'plugin_manifest_invalid',
        message: 'Re-run with --yes to apply this update.', plugins: summary,
      }));
      io.stderr('REFUSED [plugin_manifest_invalid] Re-run with --yes to apply this update.');
      return 2;
    }
    throw new PluginError('plugin_manifest_invalid', 'Re-run with --yes to apply this update.');
  }

  let declared = readFlowsConfig(root).plugins;
  let lock = readPluginLock(root);
  const applied: { name: string; ref: string; digest: string }[] = [];
  for (const plan of pending) {
    const { directory, digest } = await materializePlugin(root, plan.manifest.name, plan.files);
    if (digest !== plan.digest) throw new PluginError('plugin_source_drift', 'Materialized digest differs from the fetched digest.');
    declared = replaceDeclaredRef(declared, plan.current.ref, plan.ref);
    lock = lockWithPlugin(lock, declared, {
      name: plan.manifest.name, version: plan.manifest.version, source: plan.source,
      digest, manifestSha256: plan.manifestSha256,
      resolvedAt: (options.now ?? (() => new Date()))().toISOString(),
    });
    const { path, config } = readFlowsConfig(root);
    writeFlowsAndLock(root, path, config, declared, lock);
    await dropUnreferencedStore(root, plan.current.entry.name, plan.current.entry.digest, lock);
    applied.push({ name: plan.manifest.name, ref: plan.ref, digest });
  }
  if (parsed.json) io.stdout(JSON.stringify({ ok: true, plugins: applied }));
  else for (const item of applied) io.stdout(`Updated ${item.name}  ${item.ref}  sha256:${item.digest}  recorded in flows.json and ${PLUGIN_LOCK_FILE}`);
  return 0;
}
