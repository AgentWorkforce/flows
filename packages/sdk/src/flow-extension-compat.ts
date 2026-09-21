import { readFileSync } from 'node:fs';
import type { FlowExtensionManifest } from './flow-extension-manifest.js';
import { PluginError } from './plugin-manifest.js';
import { satisfiesRange } from './semver-range.js';

export interface RuntimeVersions { readonly sdk: string; readonly surface: string }

/** The versions a plugin's `compat` is checked against: this SDK and the surface it pins. */
export function runtimeVersions(): RuntimeVersions {
  const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string; dependencies: Record<string, string> };
  return { sdk: pkg.version, surface: pkg.dependencies['@relayflows/surface']! };
}

/** `compat.surface` / `compat.sdk` against the runtime: a miss is a refusal, never a warning. */
export function assertCompatible(manifest: FlowExtensionManifest, versions: RuntimeVersions): void {
  for (const [what, range, actual] of [['surface', manifest.compat.surface, versions.surface], ['sdk', manifest.compat.sdk, versions.sdk]] as const) {
    if (!satisfiesRange(actual, range)) throw new PluginError('plugin_incompatible', `${manifest.name} requires ${what} ${range}; this runtime has ${actual}.`);
  }
}

/**
 * `compat.base` against the flow being extended. `FlowHeader.version` is
 * optional: a base without it matches only `"*"`.
 */
export function assertBaseCompatible(manifest: FlowExtensionManifest, base: { readonly name: string; readonly version?: string }): void {
  const entry = manifest.compat.base.find(b => b.name === base.name);
  if (entry === undefined) {
    throw new PluginError('plugin_incompatible', `${manifest.name} extends ${manifest.compat.base.map(b => b.name).join(', ')}, not "${base.name}".`);
  }
  if (base.version === undefined) {
    if (entry.version !== '*') throw new PluginError('plugin_incompatible', `${manifest.name} requires ${base.name} ${entry.version}, but the base flow declares no version; only "*" can be satisfied.`);
    return;
  }
  if (!satisfiesRange(base.version, entry.version)) throw new PluginError('plugin_incompatible', `${manifest.name} requires ${base.name} ${entry.version}; the base flow is ${base.version}.`);
}
