import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CheckReport, type CliIo } from '../src/cli.js';
import {
  CHECK_INPUT_FAILURE_KINDS,
  isCheckFailureKind,
} from '../src/failure-kinds.js';

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testdata');
const PREFLIGHT = join(TESTDATA, 'preflight');
const LADDER = ['hello-ladder', 'hello-llm', 'hello-agent'] as const;
const temporaryDirectories: string[] = [];
const KERNEL_RETRY = {
  initial_backoff_ms: 100,
  max_backoff_ms: 60_000,
  multiplier: 2,
  jitter_percent: 20,
};

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

/** Every temporary CLI fixture gets a config boundary, so `/tmp/flows.json` cannot affect it. */
function temporaryProject(prefix = 'flows-check-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, 'flows.json'), JSON.stringify({ executors: [] }));
  return directory;
}

/**
 * RFC-0001 §96 makes *the ladder flows* the subject of the refusal clause, so
 * the fault is induced on the canonical flows themselves rather than on a
 * stand-in fixture. The variant is compiled from the real YAML and written to a
 * throwaway directory with its own empty flows.json, so resolution is hermetic:
 * nothing mutates PATH, the canon on disk, or an ambient project config.
 */
function ladderVariant(name: string, mutate: (flow: Record<string, unknown>) => void): string {
  const directory = temporaryProject('flows-ladder-');
  const flow = parseYaml(readFileSync(join(TESTDATA, `${name}.flow.yaml`), 'utf8')) as Record<string, unknown>;
  mutate(flow);
  const path = join(directory, `${name}.flow.yaml`);
  writeFileSync(path, stringifyYaml(flow));
  return path;
}

const LADDER_FAULTS = [
  ['cli_missing', (flow) => { flow['cli'] = join(PREFLIGHT, 'absent-cli'); }],
  ['cli_unauthenticated', (flow) => { flow['cli'] = join(PREFLIGHT, 'unauthenticated-cli'); }],
  // Relocation into ladderVariant's empty flows.json is the fault: it removes
  // the project CLI fallback, while the ladder YAML itself has no cli field.
  ['cli_unresolved', () => {}],
  ['no_executor', (flow) => {
    flow['cli'] = join(PREFLIGHT, 'authenticated-cli');
    flow['triggers'] = [{ id: 'induced-schedule', executor: 'absent-executor' }];
  }],
] as const satisfies ReadonlyArray<readonly [string, (flow: Record<string, unknown>) => void]>;

describe('flows check CLI', () => {
  it('explains kernel-dialect routing and names the offending mixed-dialect key', () => {
    const directory = temporaryProject();
    const path = join(directory, 'mixed.flow.yaml');
    writeFileSync(path, `
version: '0.1.0'
name: mixed
steps:
  - id: first
    type: deterministic
    command: printf one
    timeoutMs: 5000
  - id: second
    type: deterministic
    command: printf two
    depends_on: [first]
`);

    const result = run(path);
    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain(
      'read as a compiled kernel spec because spec.steps[1].depends_on is present',
    );
    expect(result.stderr.join('\n')).toContain('spec.steps[0]: unknown key "timeoutMs"');
  });

  it('names an unknown key and its location in a compiled kernel spec', () => {
    const directory = temporaryProject();
    const path = join(directory, 'unknown-kernel-key.json');
    writeFileSync(path, JSON.stringify({
      version: '0.1.0',
      steps: [{
        id: 'first',
        type: 'deterministic',
        command: 'printf one',
        depends_on: [],
        max_iterations: 1,
        retry: KERNEL_RETRY,
        verification: {},
        mystery: true,
      }],
    }));

    const result = run(path);
    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain('spec.steps[0]: unknown key "mystery"');
  });

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

  it('pins the complete JSON report for a pass and a refusal', () => {
    const configPath = join(PREFLIGHT, 'flows.json');
    const passPath = join(PREFLIGHT, 'cli-declared.flow.yaml');
    const pass = run(passPath, true);
    expect(pass.code).toBe(0);
    expect(JSON.parse(pass.stdout.join('\n')) as CheckReport).toEqual({
      ok: true,
      path: passPath,
      projectConfigPath: configPath,
      resolutions: [{ stepId: 'answer', cli: './authenticated-cli', source: 'step' }],
      diagnostics: [],
    });

    const refusalPath = join(PREFLIGHT, 'cli-missing.flow.yaml');
    const refusal = run(refusalPath, true);
    expect(refusal.code).toBe(2);
    const report = JSON.parse(refusal.stdout.join('\n')) as CheckReport;
    expect(report).toEqual({
      ok: false,
      path: refusalPath,
      projectConfigPath: configPath,
      resolutions: [{ stepId: 'answer', cli: './missing-cli', source: 'step' }],
      diagnostics: [{
        severity: 'refusal',
        kind: 'cli_missing',
        stepId: 'answer',
        cli: './missing-cli',
        message: 'Step "answer" declares CLI "./missing-cli", but it is missing.',
      }],
    });
    expect(report.diagnostics.every((entry) => isCheckFailureKind(entry.kind))).toBe(true);
  });

  it('checks the compiled kernel-dialect canonical spec as well as YAML', () => {
    const result = run(join(TESTDATA, 'hello-ladder.spec.canonical.json'));
    expect(result.code).toBe(0);
    expect(result.stdout.join('\n')).toContain('CHECK PASSED');
  });

  it.each([
    ['depends_on', { version: '0.1.0', steps: [{ id: 'a', type: 'deterministic', command: 'printf ok', depends_on: [] }] }],
    ['max_iterations', { version: '0.1.0', steps: [{ id: 'a', type: 'deterministic', command: 'printf ok', max_iterations: 1 }] }],
    ['retry', { version: '0.1.0', steps: [{ id: 'a', type: 'deterministic', command: 'printf ok', retry: KERNEL_RETRY }] }],
    ['timeout_ms', { version: '0.1.0', steps: [{ id: 'a', type: 'deterministic', command: 'printf ok', timeout_ms: 5_000 }] }],
    ['recovery_mode', {
      version: '0.1.0',
      cli: join(PREFLIGHT, 'authenticated-cli'),
      steps: [{ id: 'a', type: 'agent', instruction: 'act', recovery_mode: 'reset' }],
    }],
    ['verification.output_contains', {
      version: '0.1.0',
      steps: [{ id: 'a', type: 'deterministic', command: 'printf ok', verification: { output_contains: 'ok' } }],
    }],
    ['budget.max_tokens_out', {
      version: '0.1.0',
      budget: { max_tokens_out: 10 },
      steps: [{ id: 'a', type: 'deterministic', command: 'printf ok' }],
    }],
    ['permissions.file_globs', {
      version: '0.1.0',
      cli: join(PREFLIGHT, 'authenticated-cli'),
      steps: [{ id: 'a', type: 'agent', instruction: 'act', permissions: { file_globs: ['src/**'] } }],
    }],
  ] as const)('recognizes kernel dialect from %s alone', (marker, spec) => {
    const directory = temporaryProject();
    const path = join(directory, `${marker.replace('.', '-')}.spec.json`);
    writeFileSync(path, JSON.stringify(spec));

    const result = run(path);
    expect(result.code, result.stderr.join('\n')).toBe(0);
    expect(result.stdout.join('\n'), marker).toContain('CHECK PASSED');
  });

  it('rejects type-specific unknown fields in compiled specs instead of dropping them', () => {
    const directory = temporaryProject();
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

  it('rejects non-default compiled retry policies instead of dropping them', () => {
    const directory = temporaryProject();
    const compiled = JSON.parse(readFileSync(join(TESTDATA, 'hello-ladder.spec.canonical.json'), 'utf8')) as {
      steps: Array<{ retry: Record<string, unknown> }>;
    };
    compiled.steps[0]!.retry['multiplier'] = 0;
    const path = join(directory, 'bad-retry.spec.json');
    writeFileSync(path, JSON.stringify(compiled));

    const result = run(path);
    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain('retry.multiplier must equal the authoring default 2');
  });

  it('loads the final CLI resolution source from the nearest flows.json', () => {
    const result = run(join(TESTDATA, 'preflight', 'project-default', 'project-cli.flow.yaml'));
    expect(result.code).toBe(0);
    expect(result.stdout.join('\n')).toContain(
      `from project (${join(TESTDATA, 'preflight', 'project-default', 'flows.json')})`,
    );
    expect(result.stdout.join('\n')).toContain('../authenticated-cli');
  });

  it('resolves a project CLI path relative to the flows.json that declares it', () => {
    const directory = temporaryProject();
    const flowDirectory = join(directory, 'nested');
    mkdirSync(flowDirectory);
    writeFileSync(join(directory, 'flows.json'), JSON.stringify({ cli: './authenticated-cli', executors: [] }));
    const cli = join(directory, 'authenticated-cli');
    writeFileSync(cli, '#!/bin/sh\n[ "$1 $2" = "auth status" ]\n');
    chmodSync(cli, 0o755);
    const flow = join(flowDirectory, 'project-cli.flow.yaml');
    writeFileSync(flow, "version: '0.1.0'\nsteps:\n  - id: answer\n    type: llm\n    prompt: answer\n");

    const result = run(flow);
    expect(result.code).toBe(0);
    expect(result.stdout.join('\n')).toContain(
      `RESOLVED step "answer" cli "./authenticated-cli" from project (${join(directory, 'flows.json')})`,
    );
  });

  it('uses the nearest flows.json as a whole project boundary and names it on refusal', () => {
    const directory = temporaryProject();
    const nested = join(directory, 'nested');
    const flowDirectory = join(nested, 'flows');
    mkdirSync(flowDirectory, { recursive: true });
    writeFileSync(join(directory, 'flows.json'), JSON.stringify({ cli: './authenticated-cli', executors: [] }));
    writeFileSync(join(nested, 'flows.json'), JSON.stringify({ executors: [] }));
    const path = join(flowDirectory, 'shadowed.flow.yaml');
    writeFileSync(path, "version: '0.1.0'\nsteps:\n  - id: answer\n    type: llm\n    prompt: answer\n");

    const result = run(path);
    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain(`Nearest project config "${join(nested, 'flows.json')}" declares no cli`);
    expect(result.stderr.join('\n')).toContain('outer configs are shadowed');
  });

  it('maps every input refusal path to its declared kind without raw exceptions', () => {
    const directory = temporaryProject();
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
    expect(outputs.join('\n')).not.toContain('SyntaxError');
    expect(kinds.every((kind) => kind !== undefined && isCheckFailureKind(kind))).toBe(true);
  });
});
