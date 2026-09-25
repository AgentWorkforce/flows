import { describe, expect, it } from 'vitest';
import { preflight, type CliProbeOutcome, type PreflightProbes } from '../src/preflight.js';
import type { FlowSpec } from '../src/spec.js';

describe('preflight shared run cache', () => {
  it('keeps CLI, resolution source and model in the cache key', () => {
    const cliProbeCache = new Map<string, CliProbeOutcome>();
    const calls: unknown[][] = [];
    const probes: PreflightProbes = {
      cli: (...args) => { calls.push(args); return { exists: true, authenticated: true, modelAvailable: true }; },
      executor: () => true, command: () => true,
    };
    function check(cli: string, model: string, source: 'step' | 'project') {
      const spec: FlowSpec = { version: '0.1.0', name: 'cache', steps: [{
        id: 'call', type: 'llm', prompt: 'hello', model, ...(source === 'step' ? { cli } : {}),
      }] };
      return preflight(spec, { probes, cliProbeCache, projectCli: cli, models: ['a', 'b'] });
    }
    expect(check('claude', 'a', 'step').ok).toBe(true);
    expect(check('claude', 'a', 'step').ok).toBe(true);
    expect(check('claude', 'b', 'step').ok).toBe(true);
    expect(check('codex', 'a', 'step').ok).toBe(true);
    expect(check('claude', 'a', 'project').ok).toBe(true);
    expect(calls).toHaveLength(4);
  });
});
