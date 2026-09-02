import { describe, expect, it } from 'vitest';
import {
  PREFLIGHT_FAILURE_KINDS,
  PREFLIGHT_WARNING_KINDS,
} from '../src/failure-kinds.js';
import {
  CliProbeError,
  preflight,
  type CliProbeResult,
  type PreflightProbes,
} from '../src/preflight.js';
import type { FlowSpec } from '../src/spec.js';
import { compileSpec, toKernelSpec } from '../src/compile.js';

function flow(step: FlowSpec['steps'][number]): FlowSpec {
  return { version: '0.1.0', name: 'test', steps: [step] };
}

function probes(overrides: Partial<PreflightProbes> = {}): PreflightProbes {
  return {
    cli: (): CliProbeResult => ({ exists: true, authenticated: true, modelAvailable: true }),
    executor: () => true,
    command: () => true,
    ...overrides,
  };
}

describe('preflight: CLI resolution and refusal predicates', () => {
  it('validates and resolves a raw named-agent authoring spec at the public boundary', () => {
    const calls: Array<[string, string, string | undefined]> = [];
    const authored: FlowSpec = {
      version: '0.1.0',
      agents: { reviewer: { cli: 'wrapper', model: 'allowed-model' } },
      steps: [{ id: 'review', type: 'agent', agent: 'reviewer', instruction: 'Review.' }],
    };

    const result = preflight(authored, {
      models: ['allowed-model'],
      probes: probes({
        cli: (cli, source, model) => {
          calls.push([cli, source, model]);
          return { exists: true, supported: true, authenticated: true, modelAvailable: true };
        },
      }),
    });

    expect(result.ok).toBe(true);
    expect(result.resolutions).toEqual([{
      stepId: 'review',
      cli: 'wrapper',
      source: 'named',
      model: 'allowed-model',
    }]);
    expect(calls).toEqual([['wrapper', 'named', 'allowed-model']]);
  });

  it('refuses malformed raw input before any public preflight probe', () => {
    const calls: string[] = [];
    const result = preflight({
      version: '0.1.0',
      steps: [{
        id: 'agent',
        type: 'agent',
        instruction: 'Work.',
        cli: 'wrapper',
        command: 'must-not-cross-verbs',
      }],
    } as never, {
      probes: {
        cli: () => { calls.push('cli'); return { exists: true, authenticated: true }; },
        command: () => { calls.push('command'); return true; },
        executor: () => { calls.push('executor'); return true; },
      },
    });

    expect(result).toMatchObject({
      ok: false,
      resolutions: [],
      diagnostics: [{ severity: 'refusal', kind: 'invalid_spec' }],
    });
    expect(result.diagnostics[0]?.message).toContain('unknown key "command"');
    expect(calls).toEqual([]);
  });

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
    expect(unauthenticated.diagnostics[0]?.message).toContain('"locked auth status" exited non-zero');
  });

  it('probes a shared CLI once per preflight call', () => {
    let probeCount = 0;
    const sharedCliFlow: FlowSpec = {
      version: '0.1.0',
      name: 'shared-cli',
      cli: 'shared-cli',
      steps: [
        { id: 'one', type: 'llm', prompt: 'one' },
        { id: 'two', type: 'agent', instruction: 'two' },
        { id: 'three', type: 'llm', prompt: 'three' },
      ],
    };
    const injected = probes({
      cli: () => {
        probeCount += 1;
        return { exists: true, authenticated: true };
      },
    });

    expect(preflight(sharedCliFlow, { probes: injected }).ok).toBe(true);
    expect(probeCount).toBe(1);
    expect(preflight(sharedCliFlow, { probes: injected }).ok).toBe(true);
    expect(probeCount).toBe(2);
  });

  it('keeps identical relative CLI strings separate across resolution sources', () => {
    const seen: string[] = [];
    const result = preflight({
      version: '0.1.0',
      name: 'source-sensitive-cli',
      steps: [
        { id: 'step-cli', type: 'llm', prompt: 'one', cli: './shared-cli' },
        { id: 'project-cli', type: 'llm', prompt: 'two' },
      ],
    }, {
      projectCli: './shared-cli',
      probes: probes({
        cli: (_cli, source) => {
          seen.push(source);
          return source === 'step'
            ? { exists: true, authenticated: true }
            : { exists: false, authenticated: false };
        },
      }),
    });

    expect(seen).toEqual(['step', 'project']);
    expect(result.diagnostics).toContainEqual(expect.objectContaining({
      kind: 'cli_missing',
      stepId: 'project-cli',
    }));
  });

  it('reports a classified probe cause without leaking raw exception text', () => {
    const classified = preflight(flow({ id: 'a', type: 'llm', prompt: 'p', cli: 'x' }), {
      probes: probes({ cli: () => { throw new CliProbeError('timeout:10000ms'); } }),
    });
    const unclassified = preflight(flow({ id: 'a', type: 'llm', prompt: 'p', cli: 'x' }), {
      probes: probes({ cli: () => { throw new Error('raw secret'); } }),
    });

    expect(classified.diagnostics).toContainEqual(expect.objectContaining({
      kind: 'probe_failed',
      detail: 'timeout:10000ms',
    }));
    expect(classified.diagnostics[0]?.message).toContain('timed out after 10000ms');
    expect(JSON.stringify(unclassified)).not.toContain('raw secret');
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
  });

  it('does not mistake a shell prefix containing a slash for a path', () => {
    // Review caught this on PR #47. The path-like refusal keys on a slash in
    // the first word, and all three of these have one without naming a path to
    // execute. Refusing them is the "refusing would reject valid flows" failure
    // the warn behaviour exists to prevent — all three were refused before the
    // prefix-skipping fix.
    const probes = { command: () => false, cli: () => false } as unknown as PreflightProbes;
    for (const command of [
      'TMPDIR=/tmp printf ok',
      '>/tmp/out echo hi',
      'PATH=/usr/bin:$PATH mkdir x',
    ]) {
      const result = preflight(
        { version: '0.1.0', name: 't', steps: [{ id: 's', type: 'deterministic', command }] } as never,
        { probes },
      );
      const severities = new Set(result.diagnostics.filter((d) => d.stepId === 's').map((d) => d.severity));
      expect([...severities], `"${command}" must warn, not refuse`).toEqual(['warning']);
    }
  });

  it('refuses missing path-like commands but keeps warning for missing bare words', () => {
    const missingCommand = probes({ command: () => false });
    const pathLike = preflight(flow({
      id: 'path-like',
      type: 'deterministic',
      command: './ops/nonexistent.sh',
    }), { probes: missingCommand });
    const bareWord = preflight(flow({
      id: 'bare-word',
      type: 'deterministic',
      command: 'nonexistent',
    }), { probes: missingCommand });

    expect(pathLike.ok).toBe(false);
    expect(pathLike.diagnostics).toEqual([
      expect.objectContaining({ severity: 'refusal', kind: 'command_missing', stepId: 'path-like' }),
    ]);
    expect(bareWord.ok).toBe(true);
    expect(bareWord.diagnostics).toEqual([
      expect.objectContaining({ severity: 'warning', kind: 'command_unresolved', stepId: 'bare-word' }),
    ]);
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
      preflight({
        version: '0.1.0',
        steps: [{ id: 'a', type: 'deterministic', command: 'x', prompt: 'cross-verb' }],
      }, { probes: probes() }),
      preflight(flow({ id: 'a', type: 'llm', prompt: 'p', cli: 'x' }), { probes: probes({ cli: () => ({ exists: false, authenticated: false }) }) }),
      preflight(flow({ id: 'a', type: 'llm', prompt: 'p', cli: 'x' }), { probes: probes({ cli: () => ({ exists: true, authenticated: false }) }) }),
      preflight(flow({ id: 'a', type: 'llm', prompt: 'p', cli: 'x' }), { probes: probes({ cli: () => ({ exists: true, supported: false, authenticated: false }) }) }),
      preflight(flow({ id: 'a', type: 'llm', prompt: 'p' }), { probes: probes() }),
      preflight(flow({ id: 'a', type: 'deterministic', command: './missing' }), { probes: probes({ command: () => false }) }),
      preflight(flow({ id: 'a', type: 'agent', instruction: 'i', cli: 'x', model: 'typo-model' }), { models: ['known-model'], probes: probes() }),
      preflight(flow({ id: 'a', type: 'agent', instruction: 'i', cli: 'x', model: 'known-model' }), { models: ['known-model'], probes: probes({ cli: () => ({ exists: true, authenticated: true, modelAvailable: false }) }) }),
      preflight({ ...flow({ id: 'a', type: 'deterministic', command: 'x' }), triggers: [{ id: 't', executor: 'e' }] }, { probes: probes({ executor: () => false, command: () => false }) }),
      preflight(flow({ id: 'a', type: 'llm', prompt: 'p', cli: 'x' }), { probes: probes({ cli: () => { throw new Error('raw secret'); } }) }),
    ];
    const refusalKinds = scenarios.flatMap((result) => result.diagnostics)
      .filter((diagnostic) => diagnostic.severity === 'refusal')
      .map((diagnostic) => diagnostic.kind);

    expect(new Set(refusalKinds)).toEqual(new Set(PREFLIGHT_FAILURE_KINDS));
    expect(JSON.stringify(scenarios)).not.toContain('raw secret');
  });

  it('reports an unknown model even when the same step has no resolvable CLI', () => {
    const result = preflight(
      flow({ id: 'a', type: 'agent', instruction: 'i', model: 'typo-model' }),
      { models: ['known-model'], probes: probes() },
    );

    expect(result.diagnostics.map((diagnostic) => diagnostic.kind)).toEqual([
      'model_unknown',
    ]);
    expect(result.diagnostics[0]).toMatchObject({
      stepId: 'a',
      model: 'typo-model',
    });
  });

  it.each([
    ['valid first', ['valid', 'typo']],
    ['typo first', ['typo', 'valid']],
  ] as const)('validates every inline model before every probe: %s', (_label, order) => {
    const calls: string[] = [];
    const steps: Record<(typeof order)[number], FlowSpec['steps'][number]> = {
      valid: { id: 'valid', type: 'agent', cli: 'claude', model: 'known-model', instruction: 'Valid.' },
      typo: { id: 'typo', type: 'agent', cli: 'claude', model: 'known-modle', instruction: 'Typo.' },
    };

    const result = preflight({
      version: '0.1.0',
      steps: [
        { id: 'deterministic', type: 'deterministic', command: './must-not-probe' },
        ...order.map((id) => steps[id]),
      ],
      triggers: [{ id: 'trigger', executor: 'must-not-probe' }],
    }, {
      models: ['known-model'],
      probes: {
        cli: () => { calls.push('cli'); throw new Error('PROBE_CALLED'); },
        command: () => { calls.push('command'); throw new Error('PROBE_CALLED'); },
        executor: () => { calls.push('executor'); throw new Error('PROBE_CALLED'); },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ kind: 'model_unknown', stepId: 'typo', model: 'known-modle' }),
    ]);
    expect(calls).toEqual([]);
  });

  it('returns every named and inline unknown-model diagnostic in the pure first pass', () => {
    let probeCalls = 0;
    const result = preflight(compileSpec({
      version: '0.1.0',
      agents: {
        unused: { cli: 'claude', model: 'unknown-named' },
      },
      steps: [{
        id: 'inline',
        type: 'agent',
        cli: 'codex',
        model: 'unknown-inline',
        instruction: 'Review.',
      }],
    }), {
      models: ['known-model'],
      probes: probes({
        cli: () => {
          probeCalls += 1;
          return { exists: true, authenticated: true, modelAvailable: true };
        },
      }),
    });

    expect(result.diagnostics).toEqual([
      expect.objectContaining({ kind: 'model_unknown', agent: 'unused', model: 'unknown-named' }),
      expect.objectContaining({ kind: 'model_unknown', stepId: 'inline', model: 'unknown-inline' }),
    ]);
    expect(probeCalls).toBe(0);
  });

  it.each(['unused', 'shadowed'] as const)(
    'checks an unknown %s named declaration before authoring metadata is erased',
    (variant) => {
      let probeCalls = 0;
      const compiled = compileSpec({
        version: '0.1.0',
        agents: { reviewer: { cli: 'claude', model: 'typo-model' } },
        steps: variant === 'unused'
          ? [{ id: 'ready', type: 'deterministic', command: 'printf ready' }]
          : [{
              id: 'review',
              type: 'agent',
              agent: 'reviewer',
              model: 'known-model',
              instruction: 'Review.',
            }],
      });

      const result = preflight(compiled, {
        models: ['known-model'],
        probes: probes({ cli: () => {
          probeCalls += 1;
          return { exists: true, authenticated: true, modelAvailable: true };
        } }),
      });

      expect(compiled.agents?.reviewer?.model).toBe('typo-model');
      expect(result.ok).toBe(false);
      expect(result.diagnostics).toEqual([
        expect.objectContaining({ kind: 'model_unknown', agent: 'reviewer', model: 'typo-model' }),
      ]);
      expect(probeCalls).toBe(0);
      expect(toKernelSpec(compiled)).not.toHaveProperty('agents');
    },
  );
});
