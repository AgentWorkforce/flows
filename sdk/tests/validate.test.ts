import { describe, expect, it } from 'vitest';
import { validateSpec } from '../src/validate.js';
import { compileSpec, compileYaml, CompileError } from '../src/compile.js';
import type { FlowSpec } from '../src/spec.js';

// Fail-closed (AGENTS.md rule 4): a malformed spec is rejected with a concrete
// error, never silently coerced. Every case below must produce a non-ok result.

describe('validate: rejects malformed specs', () => {
  it('rejects a non-object spec', () => {
    expect(validateSpec(null).ok).toBe(false);
    expect(validateSpec('hello').ok).toBe(false);
    expect(validateSpec([]).ok).toBe(false);
  });

  it('rejects a missing version', () => {
    const r = validateSpec({ steps: [{ id: 'a', type: 'deterministic', command: 'x' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('version');
  });

  it('rejects a version the kernel does not support', () => {
    const r = validateSpec({ version: '9.9.9', name: 'x', steps: [{ id: 'a', type: 'deterministic', command: 'x' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('unsupported version "9.9.9"');
  });

  it('rejects a malformed optional name', () => {
    const r = validateSpec({ version: '0.1.0', name: '', steps: [{ id: 'a', type: 'deterministic', command: 'x' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('name');
  });

  it('rejects an empty steps array', () => {
    const r = validateSpec({ version: '0.1.0', name: 'x', steps: [] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('non-empty array');
  });

  it('rejects an unknown step type', () => {
    const r = validateSpec({ version: '0.1.0', name: 'x', steps: [{ id: 'a', type: 'integration', command: 'x' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('deterministic | llm | agent');
  });

  it('rejects duplicate step ids', () => {
    const r = validateSpec({
      version: '0.1.0',
      name: 'x',
      steps: [
        { id: 'a', type: 'deterministic', command: 'x' },
        { id: 'a', type: 'deterministic', command: 'y' },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('duplicate');
  });

  it('rejects a deterministic step missing its command', () => {
    const r = validateSpec({ version: '0.1.0', name: 'x', steps: [{ id: 'a', type: 'deterministic' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('command');
  });

  it('rejects an llm step missing its prompt', () => {
    const r = validateSpec({ version: '0.1.0', name: 'x', steps: [{ id: 'a', type: 'llm' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('prompt');
  });

  it('rejects an agent step missing its instruction', () => {
    const r = validateSpec({ version: '0.1.0', name: 'x', steps: [{ id: 'a', type: 'agent' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('instruction');
  });

  it('rejects an invalid recovery mode', () => {
    const r = validateSpec({ version: '0.1.0', name: 'x', steps: [{ id: 'a', type: 'agent', instruction: 't', recoveryMode: 'rollback' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('recoveryMode');
  });

  it('rejects a custom exit_code expectation (v0 judges exit_code == 0)', () => {
    const r = validateSpec({ version: '0.1.0', name: 'x', steps: [{ id: 'a', type: 'deterministic', command: 'x', verification: { type: 'exit_code', expect: 3 } }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('exit_code == 0');
  });

  it('rejects a timeout on a non-deterministic step (no dialect surface in v0.1.0)', () => {
    const r = validateSpec({ version: '0.1.0', name: 'x', steps: [{ id: 'a', type: 'llm', prompt: 'p', timeoutMs: 1000 }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('deterministic steps carry a timeout');
  });

  it('rejects an output_contains gate with no value', () => {
    const r = validateSpec({ version: '0.1.0', name: 'x', steps: [{ id: 'a', type: 'deterministic', command: 'x', verification: { type: 'output_contains' } }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('value');
  });

  it('rejects an unknown verification gate type', () => {
    const r = validateSpec({ version: '0.1.0', name: 'x', steps: [{ id: 'a', type: 'deterministic', command: 'x', verification: { type: 'regex' } }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('exit_code | output_contains | json_schema');
  });

  it('rejects a dependsOn referencing an unknown step', () => {
    const r = validateSpec({ version: '0.1.0', name: 'x', steps: [{ id: 'a', type: 'deterministic', command: 'x', dependsOn: ['ghost'] }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('unknown step "ghost"');
  });

  it('rejects a dependency cycle', () => {
    const r = validateSpec({
      version: '0.1.0',
      name: 'x',
      steps: [
        { id: 'a', type: 'deterministic', command: 'x', dependsOn: ['b'] },
        { id: 'b', type: 'deterministic', command: 'y', dependsOn: ['a'] },
      ],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('cycle');
  });

  it('rejects a float money budget (must be a decimal string)', () => {
    const r = validateSpec({ version: '0.1.0', name: 'x', budget: { maxDollars: 1.5 }, steps: [{ id: 'a', type: 'deterministic', command: 'x' }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('maxDollars');
  });

  it('rejects a non-integer maxIterations', () => {
    const r = validateSpec({ version: '0.1.0', name: 'x', steps: [{ id: 'a', type: 'deterministic', command: 'x', maxIterations: 2.5 }] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('maxIterations');
  });
});

describe('validate: fail-closed on unknown keys (RFC covenant 2)', () => {
  const step = { id: 'a', type: 'deterministic', command: 'x' };

  it('rejects the depends_on typo with the authoring-vocabulary suggestion', () => {
    // The regression this pins: `depends_on` used to pass validation and be
    // silently discarded, so step ordering was lost.
    const r = validateSpec({
      version: '0.1.0',
      name: 'x',
      steps: [step, { id: 'b', type: 'deterministic', command: 'y', depends_on: ['a'] }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('unknown key "depends_on" — did you mean "dependsOn"?');
  });

  it('rejects unknown keys at the root level', () => {
    const r = validateSpec({ version: '0.1.0', name: 'x', steps: [step], budgets: {} });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('spec: unknown key "budgets" — did you mean "budget"?');
  });

  it('rejects unknown keys at the budget level', () => {
    const r = validateSpec({ version: '0.1.0', name: 'x', budget: { max_dollars: '1.50' }, steps: [step] });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('spec.budget: unknown key "max_dollars" — did you mean "maxDollars"?');
  });

  it('rejects unknown keys at the step level, including per-type fields', () => {
    const r = validateSpec({
      version: '0.1.0',
      name: 'x',
      steps: [
        { id: 'a', type: 'deterministic', command: 'x', max_iterations: 2 },
        { id: 'b', type: 'llm', prompt: 'p', instruction: 'not an llm field' },
      ],
    });
    expect(r.ok).toBe(false);
    const joined = r.errors.join(' ');
    expect(joined).toContain('spec.steps[0]: unknown key "max_iterations" — did you mean "maxIterations"?');
    expect(joined).toContain('spec.steps[1]: unknown key "instruction"');
  });

  it('rejects unknown keys at the verification level', () => {
    const r = validateSpec({
      version: '0.1.0',
      name: 'x',
      steps: [{ ...step, verification: { type: 'output_contains', value: 'hi', values: 'oops' } }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('unknown key "values" — did you mean "value"?');
  });

  it('rejects unknown keys at the surfaces level (object and items)', () => {
    const r = validateSpec({
      version: '0.1.0',
      name: 'x',
      steps: [{
        id: 'a',
        type: 'agent',
        instruction: 't',
        surfaces: { workspaces: [{ surface: 'w' }], workspace: [{ surface: 'w', writable: true }] },
      }],
    });
    expect(r.ok).toBe(false);
    const joined = r.errors.join(' ');
    expect(joined).toContain('unknown key "workspaces" — did you mean "workspace"?');
    expect(joined).toContain('surfaces.workspace[0]: unknown key "writable"');
  });

  it('rejects unknown keys at the permissions level', () => {
    const r = validateSpec({
      version: '0.1.0',
      name: 'x',
      steps: [{ id: 'a', type: 'agent', instruction: 't', permissions: { file_globs: ['*'] } }],
    });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('unknown key "file_globs" — did you mean "fileGlobs"?');
  });

  it('names allowed keys when no valid key is close', () => {
    const r = validateSpec({ version: '0.1.0', name: 'x', steps: [step], zzzzzzzz: 1 });
    expect(r.ok).toBe(false);
    expect(r.errors.join(' ')).toContain('spec: unknown key "zzzzzzzz" (expected one of');
  });
});

describe('compile: surfaces validation failures as CompileError', () => {
  it('throws CompileError with the offending messages for a malformed YAML spec', () => {
    expect(() =>
      compileYaml(`
version: '0.1.0'
name: bad
steps:
  - id: a
    type: deterministic
`),
    ).toThrow(CompileError);

    let caught: CompileError | null = null;
    try {
      compileYaml(`
version: '0.1.0'
name: bad
steps:
  - id: a
    type: deterministic
`);
    } catch (e) {
      caught = e as CompileError;
    }
    expect(caught).not.toBeNull();
    expect(caught!.errors.some((m) => m.includes('command'))).toBe(true);
  });

  it('throws CompileError for YAML that is not a mapping', () => {
    expect(() => compileYaml('- just\n- a\n- list')).toThrow(CompileError);
  });
});

describe('validate: accepts the legal zero-agent flow', () => {
  it('accepts the kernel-supported schema version', () => {
    const result = validateSpec({
      version: '0.1.0',
      name: 'supported-version',
      steps: [{ id: 'a', type: 'deterministic', command: 'echo hi' }],
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('accepts a spec without a name because the kernel treats it as optional', () => {
    const nameless = {
      version: '0.1.0',
      steps: [{ id: 'a', type: 'deterministic', command: 'echo hi' }],
    };
    expect(validateSpec(nameless)).toEqual({ ok: true, errors: [] });
    expect(compileSpec(nameless)).not.toHaveProperty('name');
  });

  it('accepts a pure-deterministic spec — zero agents/llm is legal (RFC §1)', () => {
    const spec: FlowSpec = {
      version: '0.1.0',
      name: 'zero-agent',
      steps: [
        { id: 'a', type: 'deterministic', command: 'echo hi' },
        { id: 'b', type: 'deterministic', command: 'echo bye', dependsOn: ['a'] },
      ],
    };
    expect(validateSpec(spec).ok).toBe(true);
  });

  it('accepts a deterministic + llm spec', () => {
    const spec: FlowSpec = {
      version: '0.1.0',
      name: 'det-llm',
      steps: [
        { id: 'a', type: 'deterministic', command: 'echo hi' },
        { id: 'b', type: 'llm', prompt: 'say hi', dependsOn: ['a'], verification: { type: 'output_contains', value: 'hi' } },
      ],
    };
    expect(validateSpec(spec).ok).toBe(true);
  });
});

describe('validate: preflight declarations', () => {
  it('accepts CLI defaults and inert trigger data', () => {
    const result = validateSpec({
      version: '0.1.0',
      name: 'preflight-data',
      cli: 'claude',
      triggers: [{ id: 'hourly', executor: 'worker-a' }],
      steps: [{ id: 'answer', type: 'llm', prompt: 'p', cli: 'codex' }],
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it('rejects duplicate trigger ids', () => {
    const result = validateSpec({
      version: '0.1.0',
      triggers: [
        { id: 'hourly', executor: 'worker-a' },
        { id: 'hourly', executor: 'worker-b' },
      ],
      steps: [{ id: 'ready', type: 'deterministic', command: 'true' }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors).toContain('spec.triggers[1].id: duplicate trigger id "hourly"');
  });

  it('accepts a declared silence budget', () => {
    const result = validateSpec({
      version: '0.1.0',
      triggers: [{ id: 'tick', executor: 'agent-worker', staleAfterMs: 180_000 }],
      steps: [{ id: 'ready', type: 'deterministic', command: 'true' }],
    });
    expect(result).toEqual({ ok: true, errors: [] });
  });

  it.each([
    [0, 'expected a positive number'],
    [-1, 'expected a positive number'],
    [1.5, 'expected an integer'],
    ['180000', 'expected an integer'],
    [Number.MAX_VALUE, 'exceeds the i64 range'],
  ])('rejects staleAfterMs %p', (value, fragment) => {
    // A budget the kernel cannot represent fails OPEN — the sweep can never
    // mark the subscription stale — so it must not compile. Zero fails the
    // other way: it alerts on every sweep and trains an operator to ignore it.
    const result = validateSpec({
      version: '0.1.0',
      triggers: [{ id: 'tick', executor: 'agent-worker', staleAfterMs: value }],
      steps: [{ id: 'ready', type: 'deterministic', command: 'true' }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('spec.triggers[0].staleAfterMs');
    expect(result.errors.join(' ')).toContain(fragment);
  });

  it('rejects malformed and unknown trigger/CLI fields fail-closed', () => {
    const result = validateSpec({
      version: '0.1.0',
      name: 'bad-preflight-data',
      cli: '',
      triggers: [{ id: 'hourly', executor: '', worker: 'guessed' }],
      steps: [{ id: 'answer', type: 'llm', prompt: 'p', cli: '' }],
    });
    expect(result.ok).toBe(false);
    expect(result.errors.join(' ')).toContain('spec.cli');
    expect(result.errors.join(' ')).toContain('unknown key "worker"');
    expect(result.errors.join(' ')).toContain('executor');
    expect(result.errors.join(' ')).toContain('steps[0].cli');
  });
});
