import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { isScopePath, SCOPE_MODES, type MountRegistry } from './scope-compiler.js';

/**
 * Local relayfile shim: nearest relayfile.mounts.json contains
 * {version: 1, mounts: {acme: [{path: "api", modes: ["readonly"]}]}}.
 * It describes existing mount capabilities, not additional flow permissions.
 * No manifest means no known mounts. An unreadable/invalid manifest fails closed.
 */
export function readMountRegistry(start: string): MountRegistry {
  let directory = start;
  for (;;) {
    const path = join(directory, 'relayfile.mounts.json');
    let source: string;
    try {
      source = readFileSync(path, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = dirname(directory);
      if (parent === directory) return {};
      directory = parent;
      continue;
    }
    const value: unknown = JSON.parse(source);
    if (!isObject(value) || value.version !== 1
      || Object.keys(value).some(key => !['version', 'mounts'].includes(key))
      || !isObject(value.mounts)) throw new Error(`Invalid relayfile mount manifest "${path}".`);
    for (const [name, prefixes] of Object.entries(value.mounts)) {
      if (!/^[A-Za-z0-9_-]+$/.test(name) || !Array.isArray(prefixes)
        || !prefixes.every(prefix => isObject(prefix)
          && Object.keys(prefix).every(key => ['path', 'modes'].includes(key))
          && isScopePath(prefix.path) && Array.isArray(prefix.modes)
          && prefix.modes.every(mode => SCOPE_MODES.includes(mode)))) {
        throw new Error(`Invalid relayfile mount "${name}" in "${path}".`);
      }
    }
    return value.mounts as MountRegistry;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
