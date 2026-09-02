import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { stringify as stringifyYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CompileError,
  compileSpec,
  compileYaml,
  toKernelSpec,
} from '../src/compile.js';
import { runCli, type CliIo } from '../src/cli.js';
import { PREFLIGHT_FAILURE_KINDS } from '../src/failure-kinds.js';
import {
  preflight,
  type PreflightProbes,
} from '../src/preflight.js';
import type { FlowSpec, StepType } from '../src/spec.js';
import { STEP_FIELDS_BY_TYPE } from '../src/step-fields.js';
import { validateSpec } from '../src/validate.js';

type RawSpec = Record<string, unknown> & {
  steps: unknown[];
};

interface InvalidFieldCase {
  label: string;
  step: Record<string, unknown>;
  unknown: string;
  suggestion?: string;
}

const TYPO_STEP_FIELDS = [
  {
    label: 'deterministic typo',
    step: { id: 'work', type: 'deterministic', command: 'printf ok', commnad: 'printf wrong' },
    unknown: 'commnad',
    suggestion: 'command',
  },
  {
    label: 'llm typo',
    step: { id: 'work', type: 'llm', prompt: 'answer', cli: 'test-cli', promt: 'misspelled' },
    unknown: 'promt',
    suggestion: 'prompt',
  },
  {
    label: 'agent typo',
    step: { id: 'work', type: 'agent', instruction: 'act', cli: 'test-cli', instructon: 'misspelled' },
    unknown: 'instructon',
    suggestion: 'instruction',
  },
] as const satisfies readonly InvalidFieldCase[];

const VALID_STEP_BY_TYPE: Record<StepType, Record<string, unknown>> = {
  deterministic: { id: 'work', type: 'deterministic', command: 'printf ok' },
  llm: { id: 'work', type: 'llm', prompt: 'answer', cli: 'test-cli' },
  agent: { id: 'work', type: 'agent', instruction: 'act', cli: 'test-cli' },
};

const VERB_FIELD_VALUES: Record<string, unknown> = {
  command: 'printf foreign',
  prompt: 'foreign prompt',
  model: 'foreign-model',
  cli: 'foreign-cli',
  instruction: 'foreign instruction',
  surfaces: { workspace: [{ surface: 'foreign-worktree' }] },
  recoveryMode: 'reset',
  permissions: { accessPreset: 'readonly' },
};

const ALL_VERB_FIELDS = [...new Set(Object.values(STEP_FIELDS_BY_TYPE).flat())];
const CROSS_VERB_STEP_FIELDS: InvalidFieldCase[] = (
  Object.entries(STEP_FIELDS_BY_TYPE) as Array<[StepType, readonly string[]]>
).flatMap(([type, allowed]) => ALL_VERB_FIELDS
  .filter((field) => !allowed.includes(field))
  .map((field) => ({
    label: `${type} foreign ${field}`,
    step: { ...VALID_STEP_BY_TYPE[type], [field]: VERB_FIELD_VALUES[field] },
    unknown: field,
  })));

const INVALID_STEP_FIELDS: readonly InvalidFieldCase[] = [
  ...TYPO_STEP_FIELDS,
  ...CROSS_VERB_STEP_FIELDS,
];

const MALFORMED_STEP_SHAPES = [
  {
    label: 'null step',
    step: null,
    expected: 'spec.steps[0]: expected an object',
  },
  {
    label: 'non-array dependsOn',
    step: { id: 'work', type: 'deterministic', command: 'printf ok', dependsOn: 'earlier' },
    expected: 'spec.steps[0].dependsOn: expected an array of step ids',
  },
] as const;

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function specWith(step: Record<string, unknown>): RawSpec {
  return { version: '0.1.0', name: 'field-lint', steps: [step] };
}

function malformedSpecWith(step: unknown): RawSpec {
  return { version: '0.1.0', name: 'malformed-shape', steps: [step] } as RawSpec;
}

function expectedUnknownField(case_: InvalidFieldCase): string {
  return case_.suggestion === undefined
    ? `spec.steps[0]: unknown key "${case_.unknown}"`
    : `spec.steps[0]: unknown key "${case_.unknown}" — did you mean "${case_.suggestion}"?`;
}

function probes(onProbe: () => void): PreflightProbes {
  return {
    cli: () => {
      onProbe();
      return { exists: true, authenticated: true };
    },
    executor: () => {
      onProbe();
      return true;
    },
    command: () => {
      onProbe();
      return true;
    },
  };
}

describe('closed per-verb step fields', () => {
  it('pins the per-verb descriptor and generates every foreign-field pair from it', () => {
    expect(STEP_FIELDS_BY_TYPE).toEqual({
      deterministic: ['command'],
      llm: ['prompt', 'model', 'cli'],
      agent: ['instruction', 'cli', 'model', 'surfaces', 'recoveryMode', 'permissions'],
    });
    expect(CROSS_VERB_STEP_FIELDS.map(({ label }) => label).sort()).toEqual([
      'agent foreign command',
      'agent foreign prompt',
      'deterministic foreign cli',
      'deterministic foreign instruction',
      'deterministic foreign model',
      'deterministic foreign permissions',
      'deterministic foreign prompt',
      'deterministic foreign recoveryMode',
      'deterministic foreign surfaces',
      'llm foreign command',
      'llm foreign instruction',
      'llm foreign permissions',
      'llm foreign recoveryMode',
      'llm foreign surfaces',
    ]);
  });

  it.each(MALFORMED_STEP_SHAPES)('$label is a typed validation/compiler/preflight failure', (case_) => {
    const raw = malformedSpecWith(case_.step);
    let validation: ReturnType<typeof validateSpec> | undefined;

    expect(() => { validation = validateSpec(raw); }).not.toThrow();
    expect(validation).toEqual({
      ok: false,
      errors: expect.arrayContaining([case_.expected]),
    });

    for (const compile of [
      () => compileSpec(raw),
      () => compileYaml(stringifyYaml(raw)),
      () => toKernelSpec(raw as never),
    ]) {
      expect(compile).toThrow(CompileError);
      expect(compile).toThrow(case_.expected);
    }

    let probeCount = 0;
    const result = preflight(raw as never, {
      probes: probes(() => { probeCount += 1; }),
    });
    expect(result).toEqual({
      ok: false,
      resolutions: [],
      diagnostics: [{
        severity: 'refusal',
        kind: 'invalid_spec',
        message: expect.stringContaining(case_.expected),
        errors: expect.arrayContaining([case_.expected]),
      }],
    });
    expect(probeCount).toBe(0);
  });

  it.each(MALFORMED_STEP_SHAPES)('$label is refused by flows check without a raw exception', async (case_) => {
    const directory = mkdtempSync(join(tmpdir(), 'flows-malformed-shape-'));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, 'flows.json'), JSON.stringify({ executors: [] }));
    const path = join(directory, 'malformed.flow.yaml');
    writeFileSync(path, stringifyYaml(malformedSpecWith(case_.step)));
    const stdout: string[] = [];
    const stderr: string[] = [];

    const exitCode = await runCli(['check', path], {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    });

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).toContain('REFUSED [invalid_spec]');
    expect(stderr.join('\n')).toContain(case_.expected);
    expect(stderr.join('\n')).not.toContain('TypeError');
  });

  it.each(INVALID_STEP_FIELDS)('$label is rejected by every public compiler/validator path', (case_) => {
    const raw = specWith({ ...case_.step });
    const expected = expectedUnknownField(case_);

    const validation = validateSpec(raw);
    expect(validation.ok).toBe(false);
    expect(validation.errors.join('\n')).toContain(expected);

    expect(() => compileSpec(raw)).toThrow(CompileError);
    expect(() => compileSpec(raw)).toThrow(expected);
    expect(() => compileYaml(stringifyYaml(raw))).toThrow(CompileError);
    expect(() => compileYaml(stringifyYaml(raw))).toThrow(expected);

    // toKernelSpec is exported and callable directly by JavaScript consumers.
    // It must not silently strip fields just because TypeScript callers would
    // normally have passed through compileSpec first.
    expect(() => toKernelSpec(raw as never)).toThrow(CompileError);
    expect(() => toKernelSpec(raw as never)).toThrow(expected);
  });

  it.each(INVALID_STEP_FIELDS)('$label is a typed direct-preflight refusal before any probe', (case_) => {
    const raw = specWith({ ...case_.step });
    let probeCount = 0;

    const result = preflight(raw as never, {
      probes: probes(() => { probeCount += 1; }),
    });

    expect(result).toEqual({
      ok: false,
      resolutions: [],
      diagnostics: [{
        severity: 'refusal',
        kind: 'invalid_spec',
        message: expect.stringContaining(expectedUnknownField(case_)),
        errors: expect.arrayContaining([expect.stringContaining(expectedUnknownField(case_))]),
      }],
    });
    expect(probeCount).toBe(0);
    expect(PREFLIGHT_FAILURE_KINDS).toContain('invalid_spec');
  });

  it.each(INVALID_STEP_FIELDS)('$label is refused by flows check with the typed invalid_spec kind', async (case_) => {
    const directory = mkdtempSync(join(tmpdir(), 'flows-field-lint-'));
    temporaryDirectories.push(directory);
    writeFileSync(join(directory, 'flows.json'), JSON.stringify({ executors: [] }));
    const path = join(directory, 'invalid.flow.yaml');
    writeFileSync(path, stringifyYaml(specWith({ ...case_.step })));
    const stdout: string[] = [];
    const stderr: string[] = [];
    const io: CliIo = {
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
    };

    const exitCode = await runCli(['check', path], io);

    expect(exitCode).toBe(2);
    expect(stdout).toEqual([]);
    expect(stderr.join('\n')).toContain('REFUSED [invalid_spec]');
    expect(stderr.join('\n')).toContain(expectedUnknownField(case_));
  });

  it('preserves a valid v0.1.0 ladder with every declared per-verb field', () => {
    const valid: FlowSpec = {
      version: '0.1.0',
      name: 'valid-v1',
      cli: 'flow-cli',
      steps: [
        {
          id: 'prepare',
          type: 'deterministic',
          command: 'printf ready',
          dependsOn: [],
          verification: { type: 'exit_code' },
          maxIterations: 2,
          timeoutMs: 5_000,
        },
        {
          id: 'answer',
          type: 'llm',
          prompt: 'answer',
          model: 'project-model',
          cli: 'llm-cli',
          dependsOn: ['prepare'],
          verification: { type: 'output_contains', value: 'done' },
          maxIterations: 2,
        },
        {
          id: 'act',
          type: 'agent',
          instruction: 'act',
          model: 'project-model',
          cli: 'agent-cli',
          dependsOn: ['answer'],
          verification: { type: 'json_schema', schema: { type: 'object' } },
          maxIterations: 2,
          surfaces: {
            workspace: [{ surface: 'worktree' }],
            streams: [{ stream: 'updates' }],
            external: ['/github/pulls/create.json'],
          },
          recoveryMode: 'inspect',
          permissions: {
            fileGlobs: ['src/**'],
            networkAllowlist: ['example.com'],
            accessPreset: 'readwrite',
          },
        },
      ],
      budget: { maxTokensIn: 100, maxTokensOut: 50, maxDollars: '1.50' },
    };

    expect(validateSpec(valid)).toEqual({ ok: true, errors: [] });
    expect(compileSpec(valid).steps).toHaveLength(3);
    expect(compileYaml(stringifyYaml(valid)).steps).toHaveLength(3);
    expect(toKernelSpec(valid).steps.map((step) => step.type)).toEqual([
      'deterministic',
      'llm',
      'agent',
    ]);

    const result = preflight(valid, { probes: probes(() => {}) });
    expect(result.ok).toBe(true);
    expect(result.resolutions).toEqual([
      { stepId: 'answer', cli: 'llm-cli', source: 'step', model: 'project-model' },
      { stepId: 'act', cli: 'agent-cli', source: 'step', model: 'project-model' },
    ]);
  });
});
