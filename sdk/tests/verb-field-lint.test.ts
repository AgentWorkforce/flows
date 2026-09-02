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
import type { FlowSpec } from '../src/spec.js';
import { validateSpec } from '../src/validate.js';

type RawSpec = Record<string, unknown> & {
  steps: Array<Record<string, unknown>>;
};

const INVALID_STEP_FIELDS = [
  {
    label: 'deterministic typo',
    step: { id: 'work', type: 'deterministic', command: 'printf ok', commnad: 'printf wrong' },
    unknown: 'commnad',
    suggestion: 'command',
  },
  {
    label: 'deterministic cross-verb field',
    step: { id: 'work', type: 'deterministic', command: 'printf ok', prompt: 'not deterministic' },
    unknown: 'prompt',
  },
  {
    label: 'llm typo',
    step: { id: 'work', type: 'llm', prompt: 'answer', cli: 'test-cli', promt: 'misspelled' },
    unknown: 'promt',
    suggestion: 'prompt',
  },
  {
    label: 'llm cross-verb field',
    step: { id: 'work', type: 'llm', prompt: 'answer', cli: 'test-cli', instruction: 'not llm' },
    unknown: 'instruction',
  },
  {
    label: 'agent typo',
    step: { id: 'work', type: 'agent', instruction: 'act', cli: 'test-cli', instructon: 'misspelled' },
    unknown: 'instructon',
    suggestion: 'instruction',
  },
  {
    label: 'agent cross-verb field',
    step: { id: 'work', type: 'agent', instruction: 'act', cli: 'test-cli', command: 'not agent' },
    unknown: 'command',
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

function expectedUnknownField(case_: (typeof INVALID_STEP_FIELDS)[number]): string {
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
