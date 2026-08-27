import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli.js';
import {
  CHECK_FAILURE_KINDS,
  CHECK_INPUT_FAILURE_KINDS,
  PREFLIGHT_FAILURE_KINDS,
  isCheckFailureKind,
} from '../src/failure-kinds.js';

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testdata');
const PREFLIGHT = join(TESTDATA, 'preflight');
const LADDER = ['hello-ladder', 'hello-llm', 'hello-agent'] as const;
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }, stdout, stderr };
}

function run(path: string, json = false): { code: number; stdout: string[]; stderr: string[] } {
  const output = capture();
  const code = runCli(['check', ...(json ? ['--json'] : []), path], output.io);
  return { code, stdout: output.stdout, stderr: output.stderr };
}

/**
 * RFC-0001 §96 makes *the ladder flows* the subject of the refusal clause, so
 * the fault is induced on the canonical flows themselves rather than on a
 * stand-in fixture. The variant is compiled from the real YAML and written to a
 * throwaway directory with its own empty flows.json, so resolution is hermetic:
 * nothing mutates PATH, the canon on disk, or an ambient project config.
 */
function ladderVariant(name: string, mutate: (flow: Record<string, unknown>) => void): string {
  const directory = mkdtempSync(join(tmpdir(), 'flows-ladder-'));
  temporaryDirectories.push(directory);
  const flow = parseYaml(readFileSync(join(TESTDATA, `${name}.flow.yaml`), 'utf8')) as Record<string, unknown>;
  mutate(flow);
  writeFileSync(join(directory, 'flows.json'), JSON.stringify({ executors: [] }));
  const path = join(directory, `${name}.flow.yaml`);
  writeFileSync(path, stringifyYaml(flow));
  return path;
}

const LADDER_FAULTS = [
  ['cli_missing', (flow) => { flow['cli'] = join(PREFLIGHT, 'absent-cli'); }],
  ['cli_unauthenticated', (flow) => { flow['cli'] = join(PREFLIGHT, 'unauthenticated-cli'); }],
  ['cli_unresolved', (flow) => { delete flow['cli']; }],
  ['no_executor', (flow) => {
    flow['cli'] = join(PREFLIGHT, 'authenticated-cli');
    flow['triggers'] = [{ id: 'induced-schedule', executor: 'absent-executor' }];
  }],
] as const satisfies ReadonlyArray<readonly [string, (flow: Record<string, unknown>) => void]>;

describe('flows check CLI', () => {
  it('passes all three canonical ladder flows and prints their resolved CLI', () => {
    for (const name of LADDER) {
      const result = run(join(TESTDATA, `${name}.flow.yaml`));
      expect(result.code, name).toBe(0);
      expect(result.stdout.join('\n'), name).toContain('RESOLVED');
      expect(result.stdout.join('\n'), name).toContain('CHECK PASSED');
      expect(result.stderr.some((line) => line.startsWith('WARNING [unprovable_effects]')), name).toBe(true);
    }
  });

  it.each([
    ['cli-missing.flow.yaml', 'cli_missing'],
    ['cli-unauthenticated.flow.yaml', 'cli_unauthenticated'],
    ['cli-unresolved.flow.yaml', 'cli_unresolved'],
    ['no-executor.flow.yaml', 'no_executor'],
  ] as const)('refuses %s with typed kind %s and exit 2', (name, kind) => {
    const result = run(join(TESTDATA, 'preflight', name));
    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain(`REFUSED [${kind}]`);
  });

  // Control for the induced-fault cases below: relocated but unmutated, every
  // ladder flow still passes. Without this the refusals could be an artifact of
  // the temp directory rather than of the fault, and the suite would be green
  // for the wrong reason.
  it.each(LADDER)('passes relocated ladder flow %s when no fault is induced', (name) => {
    const result = run(ladderVariant(name, (flow) => { flow['cli'] = join(PREFLIGHT, 'authenticated-cli'); }));
    expect(result.code, name).toBe(0);
    expect(result.stdout.join('\n'), name).toContain('CHECK PASSED');
  });

  it.each(LADDER.flatMap((name) => LADDER_FAULTS.map(([kind, mutate]) => [name, kind, mutate] as const)))(
    'refuses ladder flow %s with %s under an induced fault',
    (name, kind, mutate) => {
      const result = run(ladderVariant(name, mutate));
      expect(result.code, `${name}/${kind}`).toBe(2);
      expect(result.stderr.join('\n'), `${name}/${kind}`).toContain(`REFUSED [${kind}]`);
    },
  );

  // The positive counterparts of the refusal fixtures: a declared CLI that
  // resolves, a trigger whose executor is registered in flows.json, and a
  // deterministic step that warns without refusing. Asserted end-to-end through
  // the CLI, where the unit tests only cover the predicates.
  it.each([
    ['cli-declared.flow.yaml', 'RESOLVED'],
    ['trigger-declared.flow.yaml', 'CHECK PASSED'],
    ['warning.flow.yaml', 'CHECK PASSED'],
  ] as const)('accepts %s without refusing', (name, expected) => {
    const result = run(join(PREFLIGHT, name));
    expect(result.code, name).toBe(0);
    expect(result.stdout.join('\n'), name).toContain(expected);
    expect(result.stderr.join('\n'), name).not.toContain('REFUSED');
  });

  it('warns on an unprovable deterministic effect while still passing the flow', () => {
    const result = run(join(PREFLIGHT, 'warning.flow.yaml'));
    expect(result.code).toBe(0);
    expect(result.stderr.join('\n')).toContain('WARNING [unprovable_effects]');
  });

  it('emits parseable JSON whose diagnostics all carry declared kinds', () => {
    const result = run(join(TESTDATA, 'preflight', 'cli-missing.flow.yaml'), true);
    expect(result.code).toBe(2);
    const report = JSON.parse(result.stdout.join('\n')) as { diagnostics: Array<{ kind: string }> };
    expect(report.diagnostics.length).toBeGreaterThan(0);
    expect(report.diagnostics.every((entry) => isCheckFailureKind(entry.kind))).toBe(true);
  });

  it('checks the compiled kernel-dialect canonical spec as well as YAML', () => {
    const result = run(join(TESTDATA, 'hello-ladder.spec.canonical.json'));
    expect(result.code).toBe(0);
    expect(result.stdout.join('\n')).toContain('CHECK PASSED');
  });

  it('rejects type-specific unknown fields in compiled specs instead of dropping them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'flows-check-'));
    temporaryDirectories.push(directory);
    const compiled = JSON.parse(readFileSync(join(TESTDATA, 'hello-ladder.spec.canonical.json'), 'utf8')) as {
      steps: Array<Record<string, unknown>>;
    };
    compiled.steps[0]!['prompt'] = 'must not be silently dropped from a deterministic step';
    const path = join(directory, 'unknown-field.spec.json');
    writeFileSync(path, JSON.stringify(compiled));

    const result = run(path);
    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain('REFUSED [invalid_spec]');
  });

  it('rejects malformed compiled retry policies instead of trusting them', () => {
    const directory = mkdtempSync(join(tmpdir(), 'flows-check-'));
    temporaryDirectories.push(directory);
    const compiled = JSON.parse(readFileSync(join(TESTDATA, 'hello-ladder.spec.canonical.json'), 'utf8')) as {
      steps: Array<{ retry: Record<string, unknown> }>;
    };
    compiled.steps[0]!.retry['multiplier'] = 0;
    const path = join(directory, 'bad-retry.spec.json');
    writeFileSync(path, JSON.stringify(compiled));

    const result = run(path);
    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain('REFUSED [invalid_spec]');
  });

  it('loads the final CLI resolution source from the nearest flows.json', () => {
    const result = run(join(TESTDATA, 'preflight', 'project-default', 'project-cli.flow.yaml'));
    expect(result.code).toBe(0);
    expect(result.stdout.join('\n')).toContain('from project');
    expect(result.stdout.join('\n')).toContain('../authenticated-cli');
  });

  it('maps every input refusal path to its declared kind without raw exceptions', () => {
    const directory = mkdtempSync(join(tmpdir(), 'flows-check-'));
    temporaryDirectories.push(directory);
    const malformed = join(directory, 'malformed.flow.yaml');
    writeFileSync(malformed, 'not: [valid');
    const valid = join(directory, 'valid.flow.yaml');
    writeFileSync(valid, "version: '0.1.0'\nname: valid\nsteps:\n  - id: ready\n    type: deterministic\n    command: printf\n");

    const invalidInvocation = capture();
    expect(runCli(['run'], invalidInvocation.io)).toBe(2);
    const outputs = [
      invalidInvocation.stderr.join('\n'),
      run(join(directory, 'absent.flow.yaml')).stderr.join('\n'),
      run(malformed).stderr.join('\n'),
    ];
    writeFileSync(join(directory, 'flows.json'), '{bad json');
    outputs.push(run(valid).stderr.join('\n'));

    const kinds = outputs.map((output) => output.match(/\[([^\]]+)]/)?.[1]);
    expect(new Set(kinds)).toEqual(new Set(CHECK_INPUT_FAILURE_KINDS));
    expect(new Set([...CHECK_INPUT_FAILURE_KINDS, ...PREFLIGHT_FAILURE_KINDS])).toEqual(new Set(CHECK_FAILURE_KINDS));
    expect(outputs.join('\n')).not.toContain('SyntaxError');
    expect(kinds.every((kind) => kind !== undefined && isCheckFailureKind(kind))).toBe(true);
  });
});
