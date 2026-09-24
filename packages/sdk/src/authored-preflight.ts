import { dirname, resolve } from 'node:path';
import { checkAuthoredFlow, readProjectConfig, type ProjectConfig } from './cli/check.js';
import { probeCliAsync } from './cli/cli-probe.js';
import { communicationInstruction } from './communication/spec.js';
import { cliProbeKey, CliProbeError, resolvePreflight, type CliProbeOutcome } from './preflight.js';
import type { FlowSpec } from './spec.js';

/** Auth/model facts belong to one execution, including concurrent cold callers. */
export function authoredPreflight(path: string) {
  const probeCache = new Map<string, CliProbeOutcome>();
  const pending = new Map<string, Promise<void>>();
  const directory = dirname(resolve(path));
  return async (flow: FlowSpec) => {
    let config: ProjectConfig;
    try { config = readProjectConfig(directory); }
    catch { return checkAuthoredFlow(flow, path); }
    const resolved = resolvePreflight(flow, {
      projectCli: config.cli, projectConfigPath: config.path, projectSearchStart: directory,
      models: config.models, modelRegistryPath: config.modelRegistryPath,
    });
    if (!resolved.ok) return checkAuthoredFlow(flow, path, config);
    await Promise.all(resolved.resolutions.map(async resolution => {
      const step = resolved.compiled!.steps.find(step => step.id === resolution.stepId)!;
      const managed = step.type === 'agent' && communicationInstruction(step.instruction) !== undefined;
      const key = cliProbeKey(resolution, managed);
      if (probeCache.has(key)) return;
      let probing = pending.get(key);
      if (probing === undefined) {
        probing = (async () => {
          try {
            probeCache.set(key, { result: await probeCliAsync(resolution.cli,
              resolution.source === 'project' ? config.directory : directory,
              resolution.model, managed ? 'managed' : undefined) });
          } catch (error) {
            probeCache.set(key, { failure: error instanceof CliProbeError ? error.detail : null });
          }
        })();
        pending.set(key, probing);
      }
      await probing;
      pending.delete(key);
    }));
    const result = checkAuthoredFlow(flow, path, config, {}, probeCache);
    return result;
  };
}
