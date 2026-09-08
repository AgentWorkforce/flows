import { accessSync, constants } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  getAuthoredFlowDefinition,
  type AuthoredFlowDefinition,
  type FlowHandle,
} from './authored-flow.js';

export class AuthoredFlowLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthoredFlowLoadError';
  }
}

/** Same signature as `getAuthoredFlowDefinition`, resolved from wherever a flow was loaded. */
export type GetFlowDefinition = <Input = unknown>(handle: FlowHandle) => AuthoredFlowDefinition<Input>;

export interface LoadedAuthoredFlow {
  readonly handle: FlowHandle;
  /**
   * Bound to the SAME `@relayflows/surface` module instance the flow file
   * itself imported `flow` from — see the comment on
   * {@link resolveGetFlowDefinition}. Callers that go on to execute the flow
   * (not just validate it) must keep using this, not the SDK's own static
   * `getAuthoredFlowDefinition` import.
   */
  readonly getDefinition: GetFlowDefinition;
}

/** Import and validate a direct-run module without executing its authored body. */
export async function loadAuthoredFlow(path: string): Promise<LoadedAuthoredFlow> {
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

  const getDefinition = await resolveGetFlowDefinition(absolutePath, path);
  const handle = authoredModule['default'] as FlowHandle;
  try {
    getDefinition(handle);
  } catch (error) {
    throw new AuthoredFlowLoadError(
      `Flow "${path}" must default-export flow(...): ${errorMessage(error)}`,
    );
  }
  return { handle, getDefinition };
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
async function resolveGetFlowDefinition(
  absolutePath: string,
  displayPath: string,
): Promise<GetFlowDefinition> {
  const require = createRequire(pathToFileURL(absolutePath));
  let resolvedRuntimePath: string;
  try {
    resolvedRuntimePath = require.resolve('@relayflows/surface/runtime');
  } catch (error) {
    throw new AuthoredFlowLoadError(
      `Flow "${displayPath}" imports @relayflows/surface, but @relayflows/surface/runtime `
        + `could not be resolved from the same location: ${errorMessage(error)}`,
    );
  }
  const runtimeModule = await import(pathToFileURL(resolvedRuntimePath).href) as {
    getFlowDefinition?: unknown;
  };
  if (typeof runtimeModule.getFlowDefinition !== 'function') {
    throw new AuthoredFlowLoadError(
      `Flow "${displayPath}": the @relayflows/surface/runtime resolved from its location `
        + 'does not export getFlowDefinition — check its @relayflows/surface version.',
    );
  }
  return runtimeModule.getFlowDefinition as GetFlowDefinition;
}

// Exported for callers (internal SDK tests, and any co-located flow that is
// provably the same `@relayflows/surface` instance as this package) that
// have no need to resolve a separate copy.
export { getAuthoredFlowDefinition };

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown authored-flow error';
}
