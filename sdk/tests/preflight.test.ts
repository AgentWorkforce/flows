import { describe, expect, it } from 'vitest';
import {
  PREFLIGHT_FAILURE_KINDS,
  PREFLIGHT_WARNING_KINDS,
} from '../src/failure-kinds.js';
import {
  preflight,
  type CliProbeResult,
  type PreflightProbes,
} from '../src/preflight.js';
import type { FlowSpec } from '../src/spec.js';

function flow(step: FlowSpec['steps'][number]): FlowSpec {
  return { version: '0.1.0', name: 'test', steps: [step] };
}

function probes(overrides: Partial<PreflightProbes> = {}): PreflightProbes {
  return {
    cli: (): CliProbeResult => ({ exists: true, authenticated: true }),
    executor: () => true,
    command: () => true,
    ...overrides,
  };
}

describe('preflight: CLI resolution and refusal predicates', () => {
  it('resolves step, then flow, then project without guessing a platform default', () => {
    const seen: string[] = [];
    const check = (spec: FlowSpec, projectCli?: string) => preflight(spec, {
      projectCli,
      probes: probes({ cli: (cli) => { seen.push(cli); return { exists: true, authenticated: true }; } }),
    });

    expect(check({ ...flow({ id: 'a', type: 'llm', prompt: 'p', cli: 'step-cli' }), cli: 'flow-cli' }, 'project-cli').resolutions[0]?.source).toBe('step');
    expect(check({ ...flow({ id: 'a', type: 'llm', prompt: 'p' }), cli: 'flow-cli' }, 'project-cli').resolutions[0]?.source).toBe('flow');
    expect(check(flow({ id: 'a', type: 'agent', instruction: 'i' }), 'project-cli').resolutions[0]?.source).toBe('project');
    expect(seen).toEqual(['step-cli', 'flow-cli', 'project-cli']);
  });

  it('keeps missing and unauthenticated CLIs distinct and names the step and CLI', () => {
    const missing = preflight(flow({ id: 'missing-step', type: 'llm', prompt: 'p', cli: 'absent' }), {
      probes: probes({ cli: () => ({ exists: false, authenticated: false }) }),
    });
    const unauthenticated = preflight(flow({ id: 'auth-step', type: 'agent', instruction: 'i', cli: 'locked' }), {
      probes: probes({ cli: () => ({ exists: true, authenticated: false }) }),
    });

    expect(missing.diagnostics).toContainEqual(expect.objectContaining({ kind: 'cli_missing', stepId: 'missing-step', cli: 'absent' }));
    expect(unauthenticated.diagnostics).toContainEqual(expect.objectContaining({ kind: 'cli_unauthenticated', stepId: 'auth-step', cli: 'locked' }));
  });

  it('refuses unresolved CLIs and triggers with no registered executor', () => {
    const unresolved = preflight(flow({ id: 'answer', type: 'llm', prompt: 'p' }), { probes: probes() });
    const noExecutor = preflight({
      ...flow({ id: 'ready', type: 'deterministic', command: 'printf ready' }),
      triggers: [{ id: 'hourly', executor: 'worker-a' }],
    }, { probes: probes({ executor: () => false }) });

    expect(unresolved.diagnostics).toContainEqual(expect.objectContaining({ kind: 'cli_unresolved', stepId: 'answer' }));
    expect(noExecutor.diagnostics).toContainEqual(expect.objectContaining({ kind: 'no_executor', triggerId: 'hourly', executor: 'worker-a' }));
  });

  it('warns on resolved deterministic commands without refusing the flow', () => {
    const result = preflight(flow({ id: 'inspect', type: 'deterministic', command: 'printf inspect' }), { probes: probes() });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', kind: 'unprovable_effects', stepId: 'inspect' }),
    ]);
    expect(PREFLIGHT_WARNING_KINDS).toContain(result.diagnostics[0]!.kind);
  });

  // Covenant 2 permits refusing *or* warning, but not silence. A deterministic
  // step that resolves, one that does not, and one that cannot be probed must
  // each leave a declared warning behind — and none of them may refuse.
  it.each([
    ['unprovable_effects', probes()],
    ['command_unresolved', probes({ command: () => false })],
    ['command_unprovable', probes({ command: () => { throw new Error('probe unavailable'); } })],
  ] as const)('never passes a deterministic step silently: warns %s', (kind, injected) => {
    const result = preflight(flow({ id: 'inspect', type: 'deterministic', command: 'inspect-thing --now' }), { probes: injected });
    expect(result.ok).toBe(true);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', kind, stepId: 'inspect' }),
    ]);
  });

  it('reaches every declared warning kind and leaks no probe exception text', () => {
    const scenarios = [
      preflight(flow({ id: 'a', type: 'deterministic', command: 'x' }), { probes: probes() }),
      preflight(flow({ id: 'a', type: 'deterministic', command: 'x' }), { probes: probes({ command: () => false }) }),
      preflight(flow({ id: 'a', type: 'deterministic', command: 'x' }), { probes: probes({ command: () => { throw new Error('raw secret'); } }) }),
    ];
    const warningKinds = scenarios.flatMap((result) => result.diagnostics)
      .filter((diagnostic) => diagnostic.severity === 'warning')
      .map((diagnostic) => diagnostic.kind);

    expect(new Set(warningKinds)).toEqual(new Set(PREFLIGHT_WARNING_KINDS));
    expect(scenarios.every((result) => result.ok)).toBe(true);
    expect(JSON.stringify(scenarios)).not.toContain('raw secret');
  });

  // This asserts reachability: every declared kind is produced by some path.
  // The converse — that no path produces an *undeclared* kind — is enforced by
  // the compiler, since PreflightRefusal.kind is typed to the declared union
  // and `tsc --noEmit` runs as part of `npm test`. Recorded so the guarantee is
  // not read as coming from this test alone.
  it('reaches every declared refusal kind, with the converse held by the type', () => {
    const scenarios = [
      preflight(flow({ id: 'a', type: 'llm', prompt: 'p', cli: 'x' }), { probes: probes({ cli: () => ({ exists: false, authenticated: false }) }) }),
      preflight(flow({ id: 'a', type: 'llm', prompt: 'p', cli: 'x' }), { probes: probes({ cli: () => ({ exists: true, authenticated: false }) }) }),
      preflight(flow({ id: 'a', type: 'llm', prompt: 'p' }), { probes: probes() }),
      preflight({ ...flow({ id: 'a', type: 'deterministic', command: 'x' }), triggers: [{ id: 't', executor: 'e' }] }, { probes: probes({ executor: () => false, command: () => false }) }),
      preflight(flow({ id: 'a', type: 'llm', prompt: 'p', cli: 'x' }), { probes: probes({ cli: () => { throw new Error('raw secret'); } }) }),
    ];
    const refusalKinds = scenarios.flatMap((result) => result.diagnostics)
      .filter((diagnostic) => diagnostic.severity === 'refusal')
      .map((diagnostic) => diagnostic.kind);

    expect(new Set(refusalKinds)).toEqual(new Set(PREFLIGHT_FAILURE_KINDS));
    expect(JSON.stringify(scenarios)).not.toContain('raw secret');
    expect(refusalKinds).not.toContain('unknown');
  });
});
