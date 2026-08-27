import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli.js';
import {
  CHECK_FAILURE_KINDS,
  CHECK_INPUT_FAILURE_KINDS,
  PREFLIGHT_FAILURE_KINDS,
  isCheckFailureKind,
} from '../src/failure-kinds.js';

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testdata');
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

describe('flows check CLI', () => {
  it('passes all three canonical ladder flows and prints their resolved CLI', () => {
    for (const name of ['hello-ladder', 'hello-llm', 'hello-agent']) {
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
