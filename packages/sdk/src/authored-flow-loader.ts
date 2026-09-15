import { accessSync, constants, existsSync, realpathSync } from 'node:fs';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getAuthoredFlowDefinition,
  type AuthoredFlowDefinition,
  type FlowHandle,
} from './authored-flow.js';

export class AuthoredFlowLoadError extends Error {
  constructor(message: string, readonly kind: 'invalid_spec' | 'use_not_found' | 'use_invalid' | 'use_cycle' = 'invalid_spec') {
    super(message);
    this.name = 'AuthoredFlowLoadError';
  }
}

/** Same signature as `getAuthoredFlowDefinition`, resolved from wherever a flow was loaded. */
export type GetFlowDefinition = <Input = unknown>(handle: FlowHandle) => AuthoredFlowDefinition<Input>;

export interface SurfaceModuleAuthority {
  readonly packageName: '@relayflows/surface';
  readonly version: string;
  readonly packageSha256: string;
  readonly runtimeSha256: string;
}

export interface LoadedAuthoredFlow {
  readonly sourcePath: string;
  readonly handle: FlowHandle;
  /**
   * Bound to the SAME `@relayflows/surface` module instance the flow file
   * itself imported `flow` from — see the comment on
   * {@link resolveGetFlowDefinition}. Callers that go on to execute the flow
   * (not just validate it) must keep using this, not the SDK's own static
   * `getAuthoredFlowDefinition` import.
   */
  readonly getDefinition: GetFlowDefinition;
  /** Exact Surface package/runtime that owns the handle's WeakMap identity. */
  readonly surfaceAuthority: SurfaceModuleAuthority;
  /** Dependency-first load order, each canonical absolute path appearing once. */
  readonly graph: readonly LoadedAuthoredFlowNode[];
}

export interface LoadedAuthoredFlowNode {
  readonly path: string;
  readonly handle: FlowHandle;
  readonly getDefinition: GetFlowDefinition;
  readonly surfaceAuthority: SurfaceModuleAuthority;
  readonly use: readonly string[];
}

/** Import and validate a direct-run module without executing its authored body. */
export async function loadAuthoredFlow(path: string): Promise<LoadedAuthoredFlow> {
  const loaded = new Map<string, LoadedAuthoredFlowNode>();
  const visiting = new Set<string>();
  async function visit(sourcePath: string, isRoot = false): Promise<LoadedAuthoredFlowNode> {
    let absolutePath: string;
    try {
      absolutePath = realpathSync(sourcePath);
      accessSync(absolutePath, constants.R_OK);
    } catch {
      throw new AuthoredFlowLoadError(`Flow "${sourcePath}" is not readable.`, isRoot ? 'invalid_spec' : 'use_not_found');
    }
    if (visiting.has(absolutePath)) {
      throw new AuthoredFlowLoadError(`Flow use cycle: ${[...visiting, absolutePath].join(' -> ')}`, 'use_cycle');
    }
    const cached = loaded.get(absolutePath);
    if (cached !== undefined) return cached;
    visiting.add(absolutePath);
    try {
      const { handle, getDefinition, surfaceAuthority } = await importAuthoredFlow(absolutePath);
      const dependencies: string[] = [];
      for (const entry of getDefinition(handle).header.use ?? []) {
        // Validate again at the SDK boundary: the author's surface package may
        // be a different version from the runtime loading the graph.
        if (!/^(?:\.\/|\.\.\/).+\.flow\.ts$/.test(entry) || /[?#\\\\]/.test(entry)) {
          throw new AuthoredFlowLoadError(`Flow "${absolutePath}" use must contain relative .flow.ts paths.`, 'use_invalid');
        }
        const child = await visit(resolve(dirname(absolutePath), entry));
        if (dependencies.includes(child.path)) {
          throw new AuthoredFlowLoadError(`Flow "${absolutePath}" declares the same use path more than once.`, 'use_invalid');
        }
        dependencies.push(child.path);
      }
      const node = Object.freeze({ path: absolutePath, handle, getDefinition, surfaceAuthority, use: Object.freeze(dependencies) });
      loaded.set(absolutePath, node);
      return node;
    } catch (error) {
      if (error instanceof AuthoredFlowLoadError && error.kind === 'invalid_spec' && !isRoot) {
        throw new AuthoredFlowLoadError(error.message, 'use_invalid');
      }
      throw error;
    } finally {
      visiting.delete(absolutePath);
    }
  }
  const root = await visit(resolve(path), true);
  return Object.freeze({ sourcePath: root.path, handle: root.handle, getDefinition: root.getDefinition,
    surfaceAuthority: root.surfaceAuthority, graph: Object.freeze([...loaded.values()]) });
}

async function importAuthoredFlow(path: string): Promise<Pick<LoadedAuthoredFlow, 'handle' | 'getDefinition' | 'surfaceAuthority'>> {
  const absolutePath = resolve(path);
  try {
    accessSync(absolutePath, constants.R_OK);
  } catch {
    throw new AuthoredFlowLoadError(`Flow "${path}" is not readable.`);
  }

  let authoredModule: Record<string, unknown>;
  try {
    authoredModule = await import(pathToFileURL(absolutePath).href) as Record<string, unknown>;
  } catch (error) {
    throw new AuthoredFlowLoadError(
      `Flow "${path}" could not be imported: ${errorMessage(error)}`,
    );
  }

  const { getDefinition, surfaceAuthority } = await resolveSurfaceRuntime(absolutePath, path);
  const handle = authoredModule['default'] as FlowHandle;
  try {
    getDefinition(handle);
  } catch (error) {
    throw new AuthoredFlowLoadError(
      `Flow "${path}" must default-export flow(...): ${errorMessage(error)}`,
    );
  }
  return { handle, getDefinition, surfaceAuthority };
}

/**
 * `getFlowDefinition` recognizes a handle by object identity in a `WeakMap`
 * scoped to whichever copy of `@relayflows/surface` created it — deliberately:
 * that is what makes a handle unforgeable (surface/tests/flow.test.ts
 * "refuses malformed and forged handles at the runtime boundary" locks this
 * in, including against a well-known-symbol forgery, so this must not be
 * "fixed" by switching that map to a symbol-tagged property instead).
 *
 * An author's `.flow.ts` almost never lives inside this monorepo. It
 * resolves `@relayflows/surface` from ITS OWN `node_modules` — a physically
 * different module instance than the one this SDK package statically
 * imports for itself, so the SDK's own copy's `WeakMap` never has the
 * entry the flow file's copy wrote. The fix is not a new identity
 * mechanism; it is asking the SAME question Node itself would ask: resolve
 * `@relayflows/surface/runtime` from the flow file's own location, exactly
 * as the flow file's `import { flow } from "@relayflows/surface"`
 * already did, and use THAT copy's `getFlowDefinition`. Since the flow
 * module already imported successfully (by the time this runs), a
 * compatible `@relayflows/surface` is provably resolvable from this same
 * anchor.
 */
async function resolveSurfaceRuntime(
  absolutePath: string,
  displayPath: string,
): Promise<{ getDefinition: GetFlowDefinition; surfaceAuthority: SurfaceModuleAuthority }> {
  const require = createRequire(pathToFileURL(absolutePath));
  let resolvedRuntimePath: string;
  try {
    resolvedRuntimePath = require.resolve('@relayflows/surface/runtime');
    // Some ESM test/load hooks return a percent-encoded absolute path without
    // a file: scheme. Normalize it only when the literal path does not exist.
    if (!existsSync(resolvedRuntimePath) && resolvedRuntimePath.includes('%')) {
      const decoded = decodeURI(resolvedRuntimePath);
      if (existsSync(decoded)) resolvedRuntimePath = decoded;
    }
  } catch (error) {
    throw new AuthoredFlowLoadError(
      `Flow "${displayPath}" imports @relayflows/surface, but @relayflows/surface/runtime `
        + `could not be resolved from the same location: ${errorMessage(error)}`,
    );
  }
  const runtimeModule = await import(/* @vite-ignore */ resolvedRuntimePath) as {
    getFlowDefinition?: unknown;
  };
  if (typeof runtimeModule.getFlowDefinition !== 'function') {
    throw new AuthoredFlowLoadError(
      `Flow "${displayPath}": the @relayflows/surface/runtime resolved from its location `
        + 'does not export getFlowDefinition — check its @relayflows/surface version.',
    );
  }
  let packagePath = dirname(resolvedRuntimePath);
  for (;;) {
    const candidate = resolve(packagePath, 'package.json');
    try {
      const packageBytes = await readFile(candidate);
      const manifest = JSON.parse(packageBytes.toString('utf8')) as { name?: unknown; version?: unknown };
      if (manifest.name === '@relayflows/surface') {
        if (typeof manifest.version !== 'string' || manifest.version.length === 0) {
          throw new AuthoredFlowLoadError(`Flow "${displayPath}": @relayflows/surface has no pinned package version.`);
        }
        const runtimeBytes = await readFile(resolvedRuntimePath);
        return {
          getDefinition: runtimeModule.getFlowDefinition as GetFlowDefinition,
          surfaceAuthority: Object.freeze({
            packageName: '@relayflows/surface', version: manifest.version,
            packageSha256: await packageTreeSha256(packagePath),
            runtimeSha256: createHash('sha256').update(runtimeBytes).digest('hex'),
          }),
        };
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && (error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    const parent = dirname(packagePath);
    if (parent === packagePath) break;
    packagePath = parent;
  }
  throw new AuthoredFlowLoadError(
    `Flow "${displayPath}": the resolved @relayflows/surface/runtime is not inside its declared package.`,
  );
}

/** Hash the exact installed Surface package tree, including path boundaries. */
async function packageTreeSha256(root: string): Promise<string> {
  const files: string[] = [];
  async function visit(directory: string): Promise<void> {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(path);
      else throw new AuthoredFlowLoadError(
        `@relayflows/surface package contains unsupported entry "${relative(root, path)}".`,
      );
    }
  }
  await visit(root);
  const hash = createHash('sha256');
  for (const path of files) {
    const bytes = await readFile(path);
    const name = relative(root, path).split(sep).join('/');
    hash.update(name).update('\0').update(String(bytes.length)).update('\0').update(bytes);
  }
  return hash.digest('hex');
}

// Exported for callers (internal SDK tests, and any co-located flow that is
// provably the same `@relayflows/surface` instance as this package) that
// have no need to resolve a separate copy.
export { getAuthoredFlowDefinition };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown authored-flow error';
}
