import { dirname, resolve } from 'node:path';
import { loadAuthoredFlow, type LoadedAuthoredFlow } from '../authored-flow-loader.js';
import { preflightWebhookTriggers } from '../preflight.js';
import { inputFailureReport, readProjectConfig, type CheckReport } from './check.js';

/** Inspect declarations without running a handler or contacting the daemon. */
export async function checkAuthoredTriggers(path: string): Promise<{
  report: CheckReport;
  loaded?: LoadedAuthoredFlow;
}> {
  try {
    const loaded = await loadAuthoredFlow(path);
    const definition = loaded.getDefinition(loaded.handle);
    const config = readProjectConfig(dirname(resolve(path)));
    const diagnostics = preflightWebhookTriggers(
      (definition.handlers ?? []).map(handler => handler.trigger), config.executors,
    );
    return {
      loaded,
      report: {
        ok: diagnostics.length === 0, path, gates: [], resolutions: [], diagnostics,
        ...(config.path === undefined ? {} : { projectConfigPath: config.path }),
      },
    };
  } catch (error) {
    return { report: inputFailureReport({
      kind: typeof error === 'object' && error !== null && 'kind' in error && error.kind === 'config_invalid'
        ? 'config_invalid' : 'invalid_spec',
      message: error instanceof Error ? error.message : 'Cannot inspect authored triggers',
    }, path) };
  }
}
