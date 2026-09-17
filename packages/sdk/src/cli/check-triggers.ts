import { dirname, resolve } from 'node:path';
import { loadAuthoredFlow, type LoadedAuthoredFlow } from '../authored-flow-loader.js';
import { preflightWebhookTriggers } from '../preflight.js';
import { preflightProviderTriggers } from '../provider-trigger-contract.js';
import { scheduleLowering } from '../schedule-trigger.js';
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
    const triggers = (definition.handlers ?? []).map(handler => handler.trigger);
    const triggerDiagnostics = preflightWebhookTriggers(triggers, config.executors);
    // Registration answers "may this inbox run here"; the provider contract
    // answers "can this subscription ever be delivered". A provider trigger
    // that passes the first and fails the second used to reach ingress and be
    // refused there, on the first real event.
    const providerDiagnostics = preflightProviderTriggers(triggers);
    const helperReport = checkSlackHelpers(definition);
    const diagnostics = [
      ...triggerDiagnostics, ...providerDiagnostics, ...helperReport.diagnostics,
    ];
    // A schedule is inspectable data: print what it lowers to, and say plainly
    // when the local runner cannot drive it. Neither is a refusal — Cloud can.
    const schedules = triggers.flatMap((trigger, handler) => {
      if (trigger.kind !== 'schedule') return [];
      const lowering = scheduleLowering(definition.name, trigger);
      return [{ handler, ...lowering }];
    });
    return {
      loaded,
      report: {
        // Severity, not emptiness: a warning must never refuse a flow.
        ok: !diagnostics.some(diagnostic => diagnostic.severity === 'refusal'),
        path, gates: [], resolutions: [], diagnostics,
        ...(schedules.length === 0 ? {} : { schedules }),
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
