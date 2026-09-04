import { accessSync, constants } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { getAuthoredFlowDefinition, type FlowHandle } from './authored-flow.js';

export class AuthoredFlowLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AuthoredFlowLoadError';
  }
}

/** Import and validate a direct-run module without executing its authored body. */
export async function loadAuthoredFlow(path: string): Promise<FlowHandle> {
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

  const handle = authoredModule['default'] as FlowHandle;
  try {
    getAuthoredFlowDefinition(handle);
  } catch (error) {
    throw new AuthoredFlowLoadError(
      `Flow "${path}" must default-export flow(...): ${errorMessage(error)}`,
    );
  }
  return handle;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'unknown authored-flow error';
}
