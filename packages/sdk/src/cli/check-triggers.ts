import { dirname, resolve } from 'node:path';
import { loadAuthoredFlow, type LoadedAuthoredFlow } from '../authored-flow-loader.js';
import { preflightWebhookTriggers } from '../preflight.js';
import { preflightProviderTriggers } from '../provider-trigger-contract.js';
import { scheduleLowering } from '../schedule-trigger.js';
import { checkSlackHelpers } from '../slack-preflight.js';
import { flowRequirements } from '../flow-requirements.js';
import { PluginError } from '../plugin-manifest.js';
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
    // `?? []` tolerates the partial loader doubles the direct-run tests install.
    const extensions = (loaded.extensions ?? []).map(extension => ({
      name: extension.name, version: extension.version, ref: extension.ref, digest: extension.digest,
      handlers: extension.handlers.length,
      hooks: Object.keys(extension.hooks ?? {}),
    }));
    const declaredHooks = definition.header.hooks ?? [];
    const implementations = (loaded.extensions ?? []).flatMap(extension =>
      Object.keys(extension.hooks ?? {}).map(hook => ({ hook, plugin: extension.name })));
    const hooks = declaredHooks.length > 0 || implementations.length > 0
      ? { declared: declaredHooks, implementations } : undefined;
    return {
      loaded,
      report: {
        // Severity, not emptiness: a warning must never refuse a flow.
        ok: !diagnostics.some(diagnostic => diagnostic.severity === 'refusal'),
        path, gates: [], resolutions: [], diagnostics,
        ...(schedules.length === 0 ? {} : { schedules }),
        ...(extensions.length === 0 ? {} : { extensions }),
        ...(hooks === undefined ? {} : { hooks }),
        requirements: flowRequirements(definition, { projectCli: config.cli }),
        ...(config.path === undefined ? {} : { projectConfigPath: config.path }),
      },
    };
  } catch (error) {
    // A flow-extension refusal keeps its own code (plugin_source_drift,
    // plugin_incompatible, …): the operator needs to know which record
    // disagreed, not that "the spec is invalid".
    if (error instanceof PluginError) return { report: inputFailureReport({ kind: error.code, message: error.message }, path) };
    return { report: inputFailureReport({
      kind: typeof error === 'object' && error !== null && 'kind' in error && error.kind === 'config_invalid'
        ? 'config_invalid' : 'invalid_spec',
      message: error instanceof Error ? error.message : 'Cannot inspect authored triggers',
    }, path) };
  }
}
