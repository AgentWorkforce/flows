import { loadAuthoredFlow } from '../authored-flow-loader.js';
import { PluginError } from '../plugin-manifest.js';
import { checkSlackHelpers } from '../slack-preflight.js';
import { inputFailureReport, type CheckExecution } from './check.js';

/** Imports the definition, but never executes arbitrary authored body code. */
export async function checkHelperBody(path: string): Promise<CheckExecution> {
  try {
    const { handle, getDefinition } = await loadAuthoredFlow(path);
    return { report: { ...checkSlackHelpers(getDefinition(handle)), path } };
  } catch (error) {
    if (error instanceof PluginError) {
      return { report: inputFailureReport({ kind: error.code, message: error.message }, path) };
    }
    return { report: inputFailureReport({ kind: 'invalid_spec',
      message: error instanceof Error ? error.message : 'Could not import authored flow.' }, path) };
  }
}
