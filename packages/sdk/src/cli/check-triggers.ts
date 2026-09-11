import { dirname, resolve } from 'node:path';
import { loadAuthoredFlow, type LoadedAuthoredFlow } from '../authored-flow-loader.js';
import { preflightWebhookTriggers } from '../preflight.js';
import { checkSlackHelpers } from '../slack-preflight.js';
import { inputFailureReport, readProjectConfig, type CheckReport } from './check.js';

/**
 * Inspect an authored flow without running a handler or contacting the daemon.
 * Combines the two authored-only preflight paths that share a loaded flow: the
 * webhook-trigger check (E) and the f.slack helper check (B). Skipping either
 * turned this into a silent trapdoor -- a `.flow.ts` using `f.slack.post`
 * without a token would pass `flows check` and only crash at run.
 */
export async function checkAuthoredTriggers(path: string): Promise<{
  report: CheckReport;
  loaded?: LoadedAuthoredFlow;
}> {
  try {
    const loaded = await loadAuthoredFlow(path);
    const definition = loaded.getDefinition(loaded.handle);
    const config = readProjectConfig(dirname(resolve(path)));
    const triggerDiagnostics = preflightWebhookTriggers(
      (definition.handlers ?? []).map(handler => handler.trigger), config.executors,
    );
    const helperReport = checkSlackHelpers(definition);
    const diagnostics = [...triggerDiagnostics, ...helperReport.diagnostics];
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
