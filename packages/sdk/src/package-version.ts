import { readFileSync } from 'node:fs';

/**
 * Read the installed SDK package version from the manifest beside this module.
 *
 * The same relative URL works from `src/` during development and `dist/` in a
 * built or npm-installed package. Reading the manifest at runtime keeps the
 * CLI output tied to the bytes that are actually installed instead of a
 * hardcoded release value that can drift between package files.
 */
export function packageVersion(): string {
  try {
    const manifest: unknown = JSON.parse(
      readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
    );
    const version = (manifest as { version?: unknown }).version;
    return typeof version === 'string' && version.length > 0 ? version : '0.0.0';
  } catch {
    // Version display is cosmetic. Keep the CLI usable if a host strips the
    // manifest from an otherwise runnable package artifact.
    return '0.0.0';
  }
}
