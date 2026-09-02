import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { once } from 'node:events';
import type { Server } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CheckReport, type CliIo } from '../src/cli.js';
import { runFlow } from '../src/cli/run.js';
import {
  CHECK_INPUT_FAILURE_KINDS,
  isCheckFailureKind,
} from '../src/failure-kinds.js';
import {
  kernelDialectError,
  sendOk,
  sendResult,
  startLoopback,
  type LoopbackHandlers,
} from './journal-client-loopback.js';

const TESTDATA = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'testdata');
const PREFLIGHT = join(TESTDATA, 'preflight');
const LADDER = ['hello-deterministic', 'hello-llm', 'hello-agent'] as const;
const TEST_MODELS = [
  'claude-haiku-4-5-20251001',
  'claude-sonnet-5',
  'deterministic-test-stub',
  'test-model-v1',
] as const;
const temporaryDirectories: string[] = [];
const loopbackServers: Server[] = [];
const KERNEL_RETRY = {
  initial_backoff_ms: 100,
  max_backoff_ms: 60_000,
  multiplier: 2,
  jitter_percent: 20,
};

afterEach(async () => {
  for (const server of loopbackServers.splice(0)) {
    await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
  }
  for (const directory of temporaryDirectories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function capture(): { io: CliIo; stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { io: { stdout: (line) => stdout.push(line), stderr: (line) => stderr.push(line) }, stdout, stderr };
}

async function run(path: string, json = false): Promise<{ code: number; stdout: string[]; stderr: string[] }> {
  const output = capture();
  const code = await runCli(['check', ...(json ? ['--json'] : []), path], output.io);
  return { code, stdout: output.stdout, stderr: output.stderr };
}

/** Every temporary CLI fixture gets a config boundary, so `/tmp/flows.json` cannot affect it. */
function temporaryProject(prefix = 'flows-check-'): string {
  const directory = mkdtempSync(join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  writeFileSync(join(directory, 'flows.json'), JSON.stringify({ executors: [], models: TEST_MODELS }));
  return directory;
}

function namedAgentProject(model: string, allowedModels: string[]): {
  directory: string;
  flowPath: string;
  probeLog: string;
} {
  const directory = temporaryProject('flows-model-');
  const cliPath = join(directory, 'model-cli');
  const probeLog = `${cliPath}.log`;
  writeFileSync(cliPath, `#!/bin/sh
test "$1 $2" = "auth status" || exit 9
printf '%s\n' "\${RELAYFLOW_MODEL-UNSET}" >> "$0.log"
test "\${RELAYFLOW_MODEL-UNSET}" = "UNSET" -o "\${RELAYFLOW_MODEL-UNSET}" = "available-model"
`);
  chmodSync(cliPath, 0o755);
  writeFileSync(join(directory, 'flows.json'), JSON.stringify({ executors: [], models: allowedModels }));
  const flowPath = join(directory, 'named-agent.flow.yaml');
  writeFileSync(flowPath, `
version: '0.1.0'
agents:
  reviewer:
    cli: ./model-cli
    model: ${model}
steps:
  - id: review
    type: agent
    agent: reviewer
    instruction: Review the change.
`);
  return { directory, flowPath, probeLog };
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

async function startCliLoopback(dataDir: string, handlers: LoopbackHandlers): Promise<void> {
  const server = startLoopback(join(dataDir, 'relayflowd.sock'), handlers);
  loopbackServers.push(server);
  if (!server.listening) await once(server, 'listening');
}

describe('flows check CLI', () => {
  it('accepts an exact allowlisted named-agent model and probes that model', async () => {
    const fixture = namedAgentProject('available-model', ['available-model']);
    const result = await run(fixture.flowPath);

    expect(result.code).toBe(0);
    expect(result.stdout.join('\n')).toContain('model "available-model"');
    expect(readFileSync(fixture.probeLog, 'utf8')).toBe('available-model\n');
  });

  it('checks the same named-agent contract from declarative JSON', async () => {
    const fixture = namedAgentProject('available-model', ['available-model']);
    const jsonPath = join(fixture.directory, 'named-agent.flow.json');
    writeFileSync(jsonPath, JSON.stringify(parseYaml(readFileSync(fixture.flowPath, 'utf8'))));

    const result = await run(jsonPath);
    expect(result.code).toBe(0);
    expect(result.stdout.join('\n')).toContain('model "available-model"');
  });

  it('refuses a typo model before probing or contacting relayflowd', async () => {
    const fixture = namedAgentProject('available-modle', ['available-model']);
    const checked = await run(fixture.flowPath);

    expect(checked.code).toBe(2);
    expect(checked.stderr.join('\n')).toContain('REFUSED [model_unknown]');
    expect(checked.stderr.join('\n')).toContain('available-modle');
    expect(existsSync(fixture.probeLog)).toBe(false);

    const output = capture();
    const runCode = await runCli([
      'run', '--data-dir', join(fixture.directory, 'no-daemon'), fixture.flowPath,
    ], output.io);
    expect(runCode).toBe(2);
    expect(output.stderr.join('\n')).toContain('REFUSED [model_unknown]');
    expect(output.stderr.join('\n')).not.toContain('daemon_unreachable');
    expect(existsSync(fixture.probeLog)).toBe(false);
  });

  it('distinguishes an allowlisted but inaccessible model from broken auth', async () => {
    const fixture = namedAgentProject('denied-model', ['denied-model']);
    const result = await run(fixture.flowPath);

    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain('REFUSED [model_unavailable]');
    expect(result.stderr.join('\n')).toContain('denied-model');
    expect(readFileSync(fixture.probeLog, 'utf8')).toBe('denied-model\nUNSET\n');
  });

  it.each([
    [{ models: ['available-model', 'available-model'] }, 'duplicate models'],
    [{ models: [' '] }, 'models[0]: expected a trimmed string'],
    [{ models: 'available-model' }, 'expected an exact string allowlist'],
  ] as const)('refuses malformed project model registry %j', async (config, expected) => {
    const directory = temporaryProject('flows-model-config-');
    writeFileSync(join(directory, 'flows.json'), JSON.stringify(config));
    const path = join(directory, 'flow.yaml');
    writeFileSync(path, "version: '0.1.0'\nsteps:\n  - id: ready\n    type: deterministic\n    command: printf ready\n");

    const result = await run(path);
    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain('REFUSED [config_invalid]');
    expect(result.stderr.join('\n')).toContain(expected);
  });

  it('explains kernel-dialect routing and names the offending mixed-dialect key', async () => {
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

    const result = await run(path);
    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain(
      'read as a compiled kernel spec because spec.steps[1].depends_on is present',
    );
    expect(result.stderr.join('\n')).toContain('spec.steps[0]: unknown key "timeoutMs"');
  });

  it('names an unknown key and its location in a compiled kernel spec', async () => {
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

    const result = await run(path);
    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain('spec.steps[0]: unknown key "mystery"');
  });

  it('passes all three canonical ladder flows and prints their resolved CLI', async () => {
    for (const name of LADDER) {
      const result = await run(join(TESTDATA, `${name}.flow.yaml`));
      expect(result.code, name).toBe(0);
      if (name !== 'hello-deterministic') {
        expect(result.stdout.join('\n'), name).toContain('RESOLVED');
      }
      expect(result.stdout.join('\n'), name).toContain('CHECK PASSED');
      expect(result.stderr.some((line) => line.startsWith('WARNING [unprovable_effects]')), name).toBe(true);
    }
  });

  it.each([
    ['cli-missing.flow.yaml', 'cli_missing'],
    ['cli-unauthenticated.flow.yaml', 'cli_unauthenticated'],
    ['cli-unresolved.flow.yaml', 'cli_unresolved'],
    ['no-executor.flow.yaml', 'no_executor'],
  ] as const)('refuses %s with typed kind %s and exit 2', async (name, kind) => {
    const result = await run(join(TESTDATA, 'preflight', name));
    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain(`REFUSED [${kind}]`);
  });

  // Control for the induced-fault cases below: relocated but unmutated, every
  // ladder flow still passes. Without this the refusals could be an artifact of
  // the temp directory rather than of the fault, and the suite would be green
  // for the wrong reason.
  it.each(LADDER)('passes relocated ladder flow %s when no fault is induced', async (name) => {
    const result = await run(ladderVariant(name, (flow) => { flow['cli'] = join(PREFLIGHT, 'authenticated-cli'); }));
    expect(result.code, name).toBe(0);
    expect(result.stdout.join('\n'), name).toContain('CHECK PASSED');
  });

  it.each(LADDER.flatMap((name) => LADDER_FAULTS
    .filter(([kind]) => name !== 'hello-deterministic' || kind === 'no_executor')
    .map(([kind, mutate]) => [name, kind, mutate] as const)))(
    'refuses ladder flow %s with %s under an induced fault',
    async (name, kind, mutate) => {
      const result = await run(ladderVariant(name, mutate));
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
  ] as const)('accepts %s without refusing', async (name, expected) => {
    const result = await run(join(PREFLIGHT, name));
    expect(result.code, name).toBe(0);
    expect(result.stdout.join('\n'), name).toContain(expected);
    expect(result.stderr.join('\n'), name).not.toContain('REFUSED');
  });

  it('warns on an unprovable deterministic effect while still passing the flow', async () => {
    const result = await run(join(PREFLIGHT, 'warning.flow.yaml'));
    expect(result.code).toBe(0);
    expect(result.stderr.join('\n')).toContain('WARNING [unprovable_effects]');
  });

  it('pins the complete JSON report for a pass and a refusal', async () => {
    const configPath = join(PREFLIGHT, 'flows.json');
    const passPath = join(PREFLIGHT, 'cli-declared.flow.yaml');
    const pass = await run(passPath, true);
    expect(pass.code).toBe(0);
    expect(JSON.parse(pass.stdout.join('\n')) as CheckReport).toEqual({
      ok: true,
      path: passPath,
      projectConfigPath: configPath,
      resolutions: [{ stepId: 'answer', cli: './authenticated-cli', source: 'step' }],
      diagnostics: [],
    });

    const refusalPath = join(PREFLIGHT, 'cli-missing.flow.yaml');
    const refusal = await run(refusalPath, true);
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
        message: 'Step "answer" declares CLI "./missing-cli", but it does not resolve as an executable.',
      }],
    });
    expect(report.diagnostics.every((entry) => isCheckFailureKind(entry.kind))).toBe(true);
  });

  it('checks the compiled kernel-dialect canonical spec as well as YAML', async () => {
    const result = await run(join(TESTDATA, 'hello-ladder.spec.canonical.json'));
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
  ] as const)('recognizes kernel dialect from %s alone', async (marker, spec) => {
    const directory = temporaryProject();
    const path = join(directory, `${marker.replace('.', '-')}.spec.json`);
    writeFileSync(path, JSON.stringify(spec));

    const result = await run(path);
    expect(result.code, result.stderr.join('\n')).toBe(0);
    expect(result.stdout.join('\n'), marker).toContain('CHECK PASSED');
  });

  it('rejects type-specific unknown fields in compiled specs instead of dropping them', async () => {
    const directory = temporaryProject();
    const compiled = JSON.parse(readFileSync(join(TESTDATA, 'hello-ladder.spec.canonical.json'), 'utf8')) as {
      steps: Array<Record<string, unknown>>;
    };
    compiled.steps[0]!['prompt'] = 'must not be silently dropped from a deterministic step';
    const path = join(directory, 'unknown-field.spec.json');
    writeFileSync(path, JSON.stringify(compiled));

    const result = await run(path);
    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain('REFUSED [invalid_spec]');
  });

  it('rejects non-default compiled retry policies instead of dropping them', async () => {
    const directory = temporaryProject();
    const compiled = JSON.parse(readFileSync(join(TESTDATA, 'hello-ladder.spec.canonical.json'), 'utf8')) as {
      steps: Array<{ retry: Record<string, unknown> }>;
    };
    compiled.steps[0]!.retry['multiplier'] = 0;
    const path = join(directory, 'bad-retry.spec.json');
    writeFileSync(path, JSON.stringify(compiled));

    const result = await run(path);
    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain('retry.multiplier must equal the authoring default 2');
  });

  it('loads the final CLI resolution source from the nearest flows.json', async () => {
    const result = await run(join(TESTDATA, 'preflight', 'project-default', 'project-cli.flow.yaml'));
    expect(result.code).toBe(0);
    expect(result.stdout.join('\n')).toContain(
      `from project (${join(TESTDATA, 'preflight', 'project-default', 'flows.json')})`,
    );
    expect(result.stdout.join('\n')).toContain('../authenticated-cli');
  });

  it('resolves a project CLI path relative to the flows.json that declares it', async () => {
    const directory = temporaryProject();
    const flowDirectory = join(directory, 'nested');
    mkdirSync(flowDirectory);
    writeFileSync(join(directory, 'flows.json'), JSON.stringify({ cli: './authenticated-cli', executors: [] }));
    const cli = join(directory, 'authenticated-cli');
    writeFileSync(cli, '#!/bin/sh\n[ "$1 $2" = "auth status" ]\n');
    chmodSync(cli, 0o755);
    const flow = join(flowDirectory, 'project-cli.flow.yaml');
    writeFileSync(flow, "version: '0.1.0'\nsteps:\n  - id: answer\n    type: llm\n    prompt: answer\n");

    const result = await run(flow);
    expect(result.code).toBe(0);
    expect(result.stdout.join('\n')).toContain(
      `RESOLVED step "answer" cli "./authenticated-cli" from project (${join(directory, 'flows.json')})`,
    );
  });

  it('uses the nearest flows.json as a whole project boundary and names it on refusal', async () => {
    const directory = temporaryProject();
    const nested = join(directory, 'nested');
    const flowDirectory = join(nested, 'flows');
    mkdirSync(flowDirectory, { recursive: true });
    writeFileSync(join(directory, 'flows.json'), JSON.stringify({ cli: './authenticated-cli', executors: [] }));
    writeFileSync(join(nested, 'flows.json'), JSON.stringify({ executors: [] }));
    const path = join(flowDirectory, 'shadowed.flow.yaml');
    writeFileSync(path, "version: '0.1.0'\nsteps:\n  - id: answer\n    type: llm\n    prompt: answer\n");

    const result = await run(path);
    expect(result.code).toBe(2);
    expect(result.stderr.join('\n')).toContain(`Nearest project config "${join(nested, 'flows.json')}" declares no cli`);
    expect(result.stderr.join('\n')).toContain('outer configs are shadowed');
  });

  it('maps every input refusal path to its declared kind without raw exceptions', async () => {
    const directory = temporaryProject();
    const malformed = join(directory, 'malformed.flow.yaml');
    writeFileSync(malformed, 'not: [valid');
    const valid = join(directory, 'valid.flow.yaml');
    writeFileSync(valid, "version: '0.1.0'\nname: valid\nsteps:\n  - id: ready\n    type: deterministic\n    command: printf\n");

    const invalidInvocation = capture();
    expect(await runCli(['run'], invalidInvocation.io)).toBe(2);
    const outputs = [
      invalidInvocation.stderr.join('\n'),
      (await run(join(directory, 'absent.flow.yaml'))).stderr.join('\n'),
      (await run(malformed)).stderr.join('\n'),
    ];
    writeFileSync(join(directory, 'flows.json'), '{bad json');
    outputs.push((await run(valid)).stderr.join('\n'));

    const kinds = outputs.map((output) => output.match(/\[([^\]]+)]/)?.[1]);
    expect(new Set(kinds)).toEqual(new Set(CHECK_INPUT_FAILURE_KINDS));
    expect(outputs.join('\n')).not.toContain('SyntaxError');
    expect(kinds.every((kind) => kind !== undefined && isCheckFailureKind(kind))).toBe(true);
  });
});

describe('flows run/resume CLI over the journal protocol', () => {
  it('parses run options, submits the kernel dialect, and exits 0 on success', async () => {
    const dataDir = temporaryProject('flows-run-success-');
    let dialectError: string | null | undefined;
    await startCliLoopback(dataDir, {
      hello: sendOk,
      'run.start': (ctx, params) => {
        dialectError = kernelDialectError(params['spec']);
        sendResult(ctx, {
          run_id: 'run-success',
          status: 'completed',
          completion_reason: 'success',
          completed_steps: 2,
        });
      },
    });
    const output = capture();

    const code = await runCli([
      'run', '--json', '--data-dir', dataDir, join(TESTDATA, 'hello-deterministic.flow.yaml'),
    ], output.io);

    expect(code).toBe(0);
    expect(dialectError).toBeNull();
    expect(JSON.parse(output.stdout.join('\n'))).toMatchObject({
      ok: true,
      command: 'run',
      runId: 'run-success',
      completionReason: 'success',
    });
  });

  it('exits 1 and emits the declared completionReason for a failed run', async () => {
    const dataDir = temporaryProject('flows-run-failed-');
    await startCliLoopback(dataDir, {
      hello: sendOk,
      'run.start': (ctx) => sendResult(ctx, {
        run_id: 'run-failed',
        status: 'failed',
        completion_reason: 'step_failed',
        completed_steps: 0,
      }),
    });
    const output = capture();

    const code = await runCli([
      'run', '--data-dir', dataDir, join(TESTDATA, 'hello-deterministic.flow.yaml'),
    ], output.io);

    expect(code).toBe(1);
    expect(output.stderr.join('\n')).toContain('FAILED [step_failed]');
    expect(output.stdout.join('\n')).toContain('completionReason: step_failed');
  });

  it('exits 3 and names the parked llm step', async () => {
    const dataDir = temporaryProject('flows-run-parked-');
    await startCliLoopback(dataDir, {
      hello: sendOk,
      'run.start': (ctx) => sendResult(ctx, {
        run_id: 'run-parked',
        status: 'parked',
        completion_reason: null,
        completed_steps: 1,
      }),
      'run.get': (ctx) => sendResult(ctx, {
        run_id: 'run-parked',
        status: 'parked',
        steps: {
          greet: { type: 'deterministic', state: 'done' },
          answer: { type: 'llm', state: 'runnable' },
          finish: { type: 'deterministic', state: 'pending' },
        },
        budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
      }),
    });
    const output = capture();

    const code = await runCli([
      'run', '--data-dir', dataDir, join(TESTDATA, 'hello-llm.flow.yaml'),
    ], output.io);

    expect(code).toBe(3);
    expect(output.stderr.join('\n')).toContain('PARKED [run_parked]');
    expect(output.stderr.join('\n')).toContain('step "answer" (llm)');
  });

  it('reports a needs_human agent step as parked for human recovery', async () => {
    const dataDir = temporaryProject('flows-run-human-');
    await startCliLoopback(dataDir, {
      hello: sendOk,
      'run.start': (ctx) => sendResult(ctx, {
        run_id: 'run-human',
        status: 'parked',
        completion_reason: null,
        completed_steps: 0,
      }),
      'run.get': (ctx) => sendResult(ctx, {
        run_id: 'run-human',
        status: 'parked',
        steps: { edit: { type: 'agent', state: 'needs_human' } },
        budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
      }),
    });
    const output = capture();

    const code = await runCli([
      'run', '--data-dir', dataDir, join(TESTDATA, 'hello-agent.flow.yaml'),
    ], output.io);

    expect(code).toBe(3);
    expect(output.stderr.join('\n')).toContain('PARKED [run_parked]');
    expect(output.stderr.join('\n')).toContain('waiting for human recovery');
    expect(output.stderr.join('\n')).not.toContain('protocol_error');
  });

  it('classifies a typed hello refusal as a protocol error, not an unreachable daemon', async () => {
    const dataDir = temporaryProject('flows-run-mismatch-');
    await startCliLoopback(dataDir, {
      hello: (ctx) => ctx.send({
        id: ctx.id,
        ok: false,
        error: { code: 'protocol_mismatch', message: 'upgrade the client' },
      }),
    });
    const output = capture();

    const code = await runCli([
      'run', '--data-dir', dataDir, join(TESTDATA, 'hello-deterministic.flow.yaml'),
    ], output.io);

    expect(code).toBe(1);
    expect(output.stderr.join('\n')).toContain('FAILED [protocol_error]');
    expect(output.stderr.join('\n')).toContain('protocol_mismatch');
    expect(output.stderr.join('\n')).not.toContain('daemon_unreachable');
  });

  it('follows a dispatched worker step instead of reporting a protocol error', async () => {
    const dataDir = temporaryProject('flows-run-worker-');
    let snapshots = 0;
    await startCliLoopback(dataDir, {
      hello: sendOk,
      'run.start': (ctx) => sendResult(ctx, {
        run_id: 'run-worker',
        status: 'parked',
        completion_reason: null,
        completed_steps: 1,
      }),
      'run.get': (ctx) => {
        const running = snapshots++ === 0;
        sendResult(ctx, {
          run_id: 'run-worker',
          status: running ? 'running' : 'completed',
          steps: {
            greet: { type: 'deterministic', state: 'done' },
            answer: running
              ? { type: 'llm', state: 'running', lease_deadline_ms: Date.now() + 5_000 }
              : { type: 'llm', state: 'done' },
            finish: { type: 'deterministic', state: running ? 'pending' : 'done' },
          },
          budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
        });
      },
      'run.resume': (ctx) => sendResult(ctx, {
        run_id: 'run-worker',
        status: 'completed',
        completion_reason: 'success',
        completed_steps: 3,
      }),
    });
    const output = capture();

    const code = await runCli([
      'run', '--data-dir', dataDir, join(TESTDATA, 'hello-llm.flow.yaml'),
    ], output.io);

    expect(code).toBe(0);
    expect(output.stdout.join('\n')).toContain('completionReason: success');
    expect(output.stderr.join('\n')).not.toContain('protocol_error');
  });

  it('bounds a worker wait by its lease and reports what it is waiting for', async () => {
    const dataDir = temporaryProject('flows-run-lease-');
    const leaseDeadlineMs = Date.now() + 150;
    let snapshots = 0;
    await startCliLoopback(dataDir, {
      hello: sendOk,
      'run.start': (ctx) => sendResult(ctx, {
        run_id: 'run-stale-worker',
        status: 'parked',
        completion_reason: null,
        completed_steps: 1,
      }),
      'run.get': (ctx) => {
        const running = snapshots++ < 4;
        sendResult(ctx, {
          run_id: 'run-stale-worker',
          status: running ? 'running' : 'completed',
          steps: {
            answer: running
              ? { type: 'llm', state: 'running', lease_deadline_ms: leaseDeadlineMs }
              : { type: 'llm', state: 'done' },
          },
          budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
        });
      },
      'run.resume': (ctx) => sendResult(ctx, {
        run_id: 'run-stale-worker',
        status: 'completed',
        completion_reason: 'success',
        completed_steps: 3,
      }),
    });
    const output = capture();

    const code = await runCli([
      'run', '--data-dir', dataDir, join(TESTDATA, 'hello-llm.flow.yaml'),
    ], output.io);

    expect(code).toBe(1);
    expect(output.stderr.join('\n')).toContain('WAITING [worker_lease]');
    expect(output.stderr.join('\n')).toContain(`until ${leaseDeadlineMs}`);
    expect(output.stderr.join('\n')).toContain('worker lease for step "answer" expired');
  });

  it('allows a caller to cancel a worker-lease wait', async () => {
    const dataDir = temporaryProject('flows-run-cancel-');
    await startCliLoopback(dataDir, {
      hello: sendOk,
      'run.start': (ctx) => sendResult(ctx, {
        run_id: 'run-cancel',
        status: 'parked',
        completion_reason: null,
        completed_steps: 1,
      }),
      'run.get': (ctx) => sendResult(ctx, {
        run_id: 'run-cancel',
        status: 'running',
        steps: {
          answer: { type: 'llm', state: 'running', lease_deadline_ms: Date.now() + 5_000 },
        },
        budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
      }),
    });
    const controller = new AbortController();

    const execution = await runFlow(
      join(TESTDATA, 'hello-llm.flow.yaml'),
      dataDir,
      { signal: controller.signal, onWait: () => controller.abort() },
    );

    expect(execution.exitCode).toBe(1);
    expect(execution.report.diagnostics).toContainEqual(expect.objectContaining({
      kind: 'protocol_error',
      message: expect.stringContaining('was canceled'),
    }));
  });

  it('resumes a parked run from snapshot step types without reading journal sequence one', async () => {
    const dataDir = temporaryProject('flows-resume-snapshot-');
    await startCliLoopback(dataDir, {
      hello: sendOk,
      'run.resume': (ctx) => sendResult(ctx, {
        run_id: 'run-current-epoch',
        status: 'parked',
        completion_reason: null,
        completed_steps: 1,
      }),
      'run.get': (ctx) => sendResult(ctx, {
        run_id: 'run-current-epoch',
        status: 'parked',
        steps: { answer: { type: 'llm', state: 'runnable' } },
        budget: { tokens_in: 0, tokens_out: 0, dollars: '0' },
      }),
    });
    const output = capture();

    const code = await runCli(['resume', '--data-dir', dataDir, 'run-current-epoch'], output.io);

    expect(code).toBe(3);
    expect(output.stderr.join('\n')).toContain('step "answer" (llm)');
    expect(output.stderr.join('\n')).not.toContain('journal.read');
  });

  it('maps only run_not_found resumes to exit 2', async () => {
    const dataDir = temporaryProject('flows-resume-');
    await startCliLoopback(dataDir, {
      hello: sendOk,
      'run.resume': (ctx, params) => {
        if (params['run_id'] === 'known-run') {
          sendResult(ctx, {
            run_id: 'known-run',
            status: 'completed',
            completion_reason: 'success',
            completed_steps: 3,
          });
          return;
        }
        if (params['run_id'] === 'write-failed') {
          ctx.send({
            id: ctx.id,
            ok: false,
            error: { code: 'journal_write_failed', message: 'disk full' },
          });
          return;
        }
        ctx.send({
          id: ctx.id,
          ok: false,
          error: { code: 'run_not_found', message: String(params['run_id']) },
        });
      },
    });
    const resumed = capture();
    const unavailable = capture();
    const failed = capture();

    expect(await runCli(['resume', '--data-dir', dataDir, 'known-run'], resumed.io)).toBe(0);
    expect(resumed.stdout.join('\n')).toContain('completionReason: success');
    expect(await runCli(['resume', '--json', '--data-dir', dataDir, 'absent-run'], unavailable.io)).toBe(2);
    expect(unavailable.stderr.join('\n')).toContain('REFUSED [run_unavailable]');
    expect(JSON.parse(unavailable.stdout.join('\n'))).toMatchObject({
      ok: false,
      command: 'resume',
      runId: 'absent-run',
      diagnostics: [{ kind: 'run_unavailable' }],
    });
    expect(await runCli(['resume', '--json', '--data-dir', dataDir, 'write-failed'], failed.io)).toBe(1);
    expect(failed.stderr.join('\n')).toContain('FAILED [protocol_error]');
    expect(JSON.parse(failed.stdout.join('\n'))).toMatchObject({
      ok: false,
      command: 'resume',
      runId: 'write-failed',
      diagnostics: [{ kind: 'protocol_error' }],
    });
  });

  it('refuses malformed options with usage naming check, run, and resume', async () => {
    for (const args of [
      ['run'],
      ['run', '--data-dir', 'flow.yaml'],
      ['run', '--data-dir', 'one', '--data-dir', 'two', 'flow.yaml'],
      ['resume', '--unknown', 'run-id'],
      ['check', '--data-dir', 'data', 'flow.yaml'],
    ]) {
      const output = capture();
      expect(await runCli(args, output.io), args.join(' ')).toBe(2);
      expect(output.stderr.join('\n'), args.join(' ')).toContain('flows check');
      expect(output.stderr.join('\n'), args.join(' ')).toContain('flows run');
      expect(output.stderr.join('\n'), args.join(' ')).toContain('flows resume');
    }
  });
});
