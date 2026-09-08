// Resolving the `relayflowd` binary (kernel/DAEMON-LIFECYCLE.md §3.1).
//
// Never PATH alone. A version manager (nvm, volta, asdf, mise) can launch Node
// with a minimal PATH, and that is exactly the case where a `which` lookup
// fails to see the binary the installer placed next to its own launcher. The
// multi-anchor order below is ported from ../relay's
// packages/harness-driver/src/broker-path.ts for that reason.

import { createRequire } from 'node:module';
import { accessSync, constants, existsSync, realpathSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** How far up from cwd a source checkout is searched for `kernel/Cargo.toml`. */
const SOURCE_CHECKOUT_MAX_DEPTH = 8;

/** Refusal from {@link resolveRelayflowdBinary}; carries every anchor tried. */
export class RelayflowdNotFoundError extends Error {
  readonly attempts: readonly string[];

  constructor(message: string, attempts: readonly string[]) {
    super(message);
    this.name = 'RelayflowdNotFoundError';
    this.attempts = attempts;
  }
}

/** Injectable seams. Unit tests reach no real filesystem and spawn nothing. */
export interface RelayflowdPathDeps {
  env: NodeJS.ProcessEnv;
  /** `process.argv[1]` — the running `flows` entrypoint, possibly a symlink. */
  entrypoint: string | undefined;
  cwd: string;
  /** This module's own directory, the third `createRequire` anchor. */
  moduleDir: string;
  platform: string;
  arch: string;
  isExecutable(path: string): boolean;
  exists(path: string): boolean;
  realpath(path: string): string;
  /** `require.resolve(specifier)` from `anchor`, or null when unresolvable. */
  resolveFrom(specifier: string, anchor: string): string | null;
  /** `which`/`where` lookup, or null. */
  which(command: string): string | null;
}

export const defaultRelayflowdPathDeps: RelayflowdPathDeps = {
  env: process.env,
  entrypoint: process.argv[1],
  cwd: process.cwd(),
  moduleDir: dirname(fileURLToPath(import.meta.url)),
  platform: process.platform,
  arch: process.arch,
  isExecutable(path) {
    try {
      accessSync(path, constants.X_OK);
      return statSync(path).isFile();
    } catch {
      return false;
    }
  },
  exists: (path) => existsSync(path),
  realpath(path) {
    try {
      return realpathSync(path);
    } catch {
      return path;
    }
  },
  resolveFrom(specifier, anchor) {
    try {
      return createRequire(anchor).resolve(specifier);
    } catch {
      return null;
    }
  },
  which(command) {
    const finder = process.platform === 'win32' ? 'where' : 'which';
    const found = spawnSync(finder, [command], { encoding: 'utf8' });
    if (found.status !== 0 || typeof found.stdout !== 'string') return null;
    const first = found.stdout.split('\n')[0]?.trim();
    return first === undefined || first.length === 0 ? null : first;
  },
};

/**
 * The published runtime package for this host, e.g.
 * `@relayflows/runtime-linux-x64` (see packages/runtime-linux-x64).
 */
export function runtimePackageName(platform: string, arch: string): string {
  return `@relayflows/runtime-${platform}-${arch}`;
}

/**
 * Locate `relayflowd`, or refuse.
 *
 * Order is §3.1's, and the first anchor is a hard stop rather than a
 * preference: an operator who exported `RELAYFLOWD_BIN` meant it, so a value
 * that is not executable refuses instead of quietly falling through to PATH.
 * Silent fallback is what AGENTS.md rule 4 forbids.
 */
export function resolveRelayflowdBinary(
  deps: RelayflowdPathDeps = defaultRelayflowdPathDeps,
): string {
  const attempts: string[] = [];

  const override = deps.env['RELAYFLOWD_BIN'];
  if (override !== undefined && override.length > 0) {
    if (deps.isExecutable(override)) return override;
    throw new RelayflowdNotFoundError(
      `RELAYFLOWD_BIN is set to "${override}", which is not an executable file. `
        + 'Point it at a relayflowd binary or unset it; it is not ignored.',
      [`RELAYFLOWD_BIN=${override}`],
    );
  }

  for (const candidate of [
    () => siblingOfEntrypoint(deps),
    () => runtimePackageBinary(deps),
    () => sourceCheckoutBinary(deps),
    () => deps.which('relayflowd'),
  ]) {
    const found = candidate();
    if (found === null) continue;
    attempts.push(found);
    if (deps.isExecutable(found)) return found;
  }

  const runtime = runtimePackageName(deps.platform, deps.arch);
  throw new RelayflowdNotFoundError(
    `No relayflowd binary could be found. Install the runtime package for this host `
      + `(${runtime}), or set RELAYFLOWD_BIN to a relayflowd executable.`
      + (attempts.length === 0 ? '' : ` Tried: ${attempts.join(', ')}.`),
    attempts,
  );
}

/**
 * The published layout: `bin/flows` and `bin/relayflowd` side by side.
 * `realpath` matters — a package-manager launcher exposes the entrypoint as a
 * symlink whose target sits in the real install tree, and the sibling is next
 * to the target, not next to the link.
 */
function siblingOfEntrypoint(deps: RelayflowdPathDeps): string | null {
  if (deps.entrypoint === undefined || deps.entrypoint.length === 0) return null;
  return join(dirname(deps.realpath(deps.entrypoint)), 'relayflowd');
}

/**
 * The optional-dependency package, tried from several `createRequire` anchors.
 * Several because a globally installed `flows` resolving a per-project optional
 * dependency sits outside the consumer's `node_modules` — broker-path.ts:84-106
 * verbatim in its reasoning.
 */
function runtimePackageBinary(deps: RelayflowdPathDeps): string | null {
  const specifier = `${runtimePackageName(deps.platform, deps.arch)}/package.json`;
  const anchors = [
    deps.moduleDir.endsWith('/') ? deps.moduleDir : `${deps.moduleDir}/`,
    ...(deps.entrypoint === undefined ? [] : [deps.entrypoint]),
    join(deps.cwd, 'package.json'),
  ];
  for (const anchor of anchors) {
    const manifest = deps.resolveFrom(specifier, anchor);
    if (manifest === null) continue;
    return join(dirname(manifest), 'bin', 'relayflowd');
  }
  return null;
}

/**
 * A source checkout: the nearest ancestor of cwd holding `kernel/Cargo.toml`,
 * then release before debug. Bounded, so a deep cwd cannot walk to `/`.
 */
function sourceCheckoutBinary(deps: RelayflowdPathDeps): string | null {
  let directory = resolve(deps.cwd);
  for (let depth = 0; depth < SOURCE_CHECKOUT_MAX_DEPTH; depth += 1) {
    if (deps.exists(join(directory, 'kernel', 'Cargo.toml'))) {
      for (const profile of ['release', 'debug']) {
        const candidate = join(directory, 'kernel', 'target', profile, 'relayflowd');
        if (deps.isExecutable(candidate)) return candidate;
      }
      return null;
    }
    const parent = dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }
  return null;
}
