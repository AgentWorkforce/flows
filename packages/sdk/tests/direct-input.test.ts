import {
  accessSync,
  constants,
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { socketPathFor } from '../src/daemon-connection.js';
import { JournalClient } from '../src/journal-client.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILT_CLI = join(ROOT, 'packages', 'sdk', 'dist', 'cli.js');
const FLOW = join(ROOT, 'packages', 'sdk', 'tests', 'fixtures', 'direct-input.flow.ts');
const CONTROL_FLOW = join(ROOT, 'packages', 'sdk', 'tests', 'fixtures', 'direct-output-control.flow.ts');
const SIDE_EFFECT_FLOW = join(ROOT, 'packages', 'sdk', 'tests', 'fixtures', 'pre-journal-side-effect.flow.ts');
const BAD_MODEL_FLOW = join(
  ROOT, 'packages', 'sdk', 'tests', 'fixtures', 'named-agent-bad-model', 'bad-model.flow.ts',
);
const TOOLCHAIN_TARGET = process.env['CARGO_TARGET_DIR']
  ?? join(process.env['RELAYFLOWS_TOOLCHAIN_HOME'] ?? join(homedir(), '.relayflows-toolchain'), 'target');
const RELAYFLOWD = resolve(process.env['RELAYFLOWD_BIN'] ?? locateRelayflowd());
const temporaryDirectories: string[] = [];
const daemons: ChildProcess[] = [];

beforeAll(() => {
  requireExecutable(RELAYFLOWD, 'relayflowd');
  requireExecutable(BUILT_CLI, 'built flows CLI');
});

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await stopDaemon(daemon);
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('direct .flow.ts input through the built CLI and live runtime', () => {
  it('returns exit 3 for an authored human handoff and persists its outcome', async () => {
    const dataDir = join(temporaryDirectory(), 'data');
    await startDaemon(dataDir);
    const result = invokeCli([
      'run', join(ROOT, 'packages/sdk/tests/fixtures/needs-human.flow.ts'), '--input', '{}', '--data-dir', dataDir, '--json',
    ]);
    expect(result.status, result.stderr).toBe(3);
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('parked');
    expect(report.ok).toBe(false);
    expect(report.diagnostics[0].message).toContain('needs_human');
    const client = new JournalClient(socketPathFor(dataDir));
    try {
      await client.connect();
      await client.hello('handoff-evidence');
      const journal = await client.journalRead(report.runId, 1);
      const rootCompletion = (journal.entries as Array<Record<string, unknown>>)
        .find(entry => entry['entry_type'] === 'step.completed'
          && entry['step_id'] === 'authored-root');
      expect(rootCompletion).toEqual(expect.objectContaining({
        entry_type: 'step.completed', payload: expect.objectContaining({
          completionReason: 'success',
          output: expect.objectContaining({ completionReason: 'needs_human' }),
        }),
      }));
      const output = (rootCompletion!['payload'] as { output: unknown }).output as {
        journalSteps: Array<{ id: string; runId: string }>;
      };
      const terminal = output.journalSteps.find(step => step.id.startsWith('complete-'))!;
      const child = await client.journalRead(terminal.runId, 1);
      expect(child.entries).toContainEqual(expect.objectContaining({
        entry_type: 'step.completed', payload: expect.objectContaining({
          completionReason: 'success',
          output: expect.objectContaining({ stdout_tail: '{"completionReason":"needs_human"}' }),
        }),
      }));
    } finally { client.close(); }
  });

  it('returns exit 1 for an authored step_failed verdict and persists its outcome', async () => {
    const dataDir = join(temporaryDirectory(), 'data');
    await startDaemon(dataDir);
    const result = invokeCli([
      'run', join(ROOT, 'packages/sdk/tests/fixtures/step-failed.flow.ts'), '--input', '{}', '--data-dir', dataDir, '--json',
    ]);
    // Exit 1, not the parked 3: nothing is waiting for a human here. This is
    // the exact invocation that used to die as
    // `protocol_error: unsupported_completion`.
    expect(result.status, result.stderr).toBe(1);
    expect(result.stderr).toContain('FAILED [step_failed]');
    expect(result.stderr).not.toContain('protocol_error');
    const report = JSON.parse(result.stdout);
    expect(report.status).toBe('failed');
    expect(report.ok).toBe(false);
    expect(report.completionReason).toBe('step_failed');
    const client = new JournalClient(socketPathFor(dataDir));
    try {
      await client.connect();
      await client.hello('step-failed-evidence');
      const journal = await client.journalRead(report.runId, 1);
      const rootCompletion = (journal.entries as Array<Record<string, unknown>>)
        .find(entry => entry['entry_type'] === 'step.completed'
          && entry['step_id'] === 'authored-root');
      // The root step itself SUCCEEDED; the adverse verdict is its output.
      expect(rootCompletion).toEqual(expect.objectContaining({
        entry_type: 'step.completed', payload: expect.objectContaining({
          completionReason: 'success',
          output: expect.objectContaining({ completionReason: 'step_failed' }),
        }),
      }));
      const output = (rootCompletion!['payload'] as { output: unknown }).output as {
        journalSteps: Array<{ id: string; runId: string; completionReason: string }>;
      };
      // Every lowered step succeeded, terminal marker included.
      expect(output.journalSteps.map(step => step.completionReason))
        .toEqual(['success', 'success', 'success']);
      const terminal = output.journalSteps.find(step => step.id.startsWith('complete-'))!;
      const child = await client.journalRead(terminal.runId, 1);
      expect(child.entries).toContainEqual(expect.objectContaining({
        entry_type: 'step.completed', payload: expect.objectContaining({
          completionReason: 'success',
          output: expect.objectContaining({ stdout_tail: '{"completionReason":"step_failed"}' }),
        }),
      }));
      // The pull request opened before the verdict is still readable. An
      // adverse verdict truncates nothing that came before it.
      const opened = output.journalSteps.find(step => step.id === 'run-1')!;
      const openedJournal = await client.journalRead(opened.runId, 1);
      expect(openedJournal.entries).toContainEqual(expect.objectContaining({
        entry_type: 'step.completed', payload: expect.objectContaining({
          output: expect.objectContaining({
            stdout_tail: 'https://github.com/AgentWorkforce/cloud-e2e-sandbox/pull/25',
          }),
        }),
      }));
    } finally { client.close(); }
  });

  it('executes inline and file JSON input through relayflowd', async () => {
    const directory = temporaryDirectory();
    const dataDir = join(directory, 'data');
    await startDaemon(dataDir);

    const inlineOutput = join(directory, 'inline.txt');
    const inline = invokeCli([
      'run', FLOW, '--input', JSON.stringify({ output: inlineOutput, value: 'inline value' }),
      '--data-dir', dataDir,
    ]);
    expect(inline.status, inline.stderr).toBe(0);
    expect(inline.stdout).toContain('completionReason: success');
    expect(readFileSync(inlineOutput, 'utf8')).toBe('inline value');

    const fileOutput = join(directory, 'file.txt');
    const inputPath = join(directory, 'input.json');
    writeFileSync(inputPath, JSON.stringify({ output: fileOutput, value: 'file value' }));
    const file = invokeCli(['run', FLOW, '--input', inputPath, '--data-dir', dataDir]);
    expect(file.status, file.stderr).toBe(0);
    expect(file.stdout).toContain('completionReason: success');
    expect(readFileSync(fileOutput, 'utf8')).toBe('file value');

    const controlOutput = join(directory, 'control.txt');
    const control = invokeCli([
      'run', CONTROL_FLOW, '--input', JSON.stringify({ output: controlOutput }),
      '--data-dir', dataDir,
    ]);
    expect(control.status, control.stderr).toBe(0);
    expect(control.stdout).toContain('completionReason: success');
    expect(readFileSync(controlOutput, 'utf8')).toBe(
      'truthy,negation,loose,strict,ternary,and,or',
    );
  });

  it('refuses missing and malformed input before contacting relayflowd', () => {
    const directory = temporaryDirectory();
    const unreachableDataDir = join(directory, 'absent-daemon');

    const missing = invokeCli(['run', FLOW, '--data-dir', unreachableDataDir]);
    expect(missing.status, missing.stderr).toBe(2);
    expect(missing.stderr).toContain('REFUSED [input_missing]');
    expect(missing.stderr).not.toContain('daemon_unreachable');

    const malformed = invokeCli([
      'run', FLOW, '--input', '{"broken":', '--data-dir', unreachableDataDir,
    ]);
    expect(malformed.status, malformed.stderr).toBe(2);
    expect(malformed.stderr).toContain('REFUSED [input_invalid]');
    expect(malformed.stderr).not.toContain('daemon_unreachable');

    const invalidFile = join(directory, 'invalid.json');
    writeFileSync(invalidFile, '{"broken":');
    const invalidFromFile = invokeCli([
      'run', FLOW, '--input', invalidFile, '--data-dir', unreachableDataDir,
    ]);
    expect(invalidFromFile.status, invalidFromFile.stderr).toBe(2);
    expect(invalidFromFile.stderr).toContain('REFUSED [input_invalid]');
    expect(invalidFromFile.stderr).toContain(`Input file "${invalidFile}" is not valid JSON`);

    const missingInputValue = invokeCli(['run', FLOW, '--input', '--json']);
    expect(missingInputValue.status, missingInputValue.stderr).toBe(2);
    expect(missingInputValue.stderr).toContain('REFUSED [invalid_invocation]');
  });

  it('surfaces the specific preflight refusal kind for an unresolved f.agent, not a generic invalid_spec', async () => {
    // authored-flow-executor.ts's lowerAgent wraps every checkAuthoredFlow
    // refusal as one AuthoredFlowExecutionError code (agent_cli_unresolved)
    // so f.agent has one throw site regardless of which preflight predicate
    // failed — but direct-run.ts used to then hardcode `kind: 'invalid_spec'`
    // in the CLI's JSON/text report for all of them, losing the closed
    // refusal taxonomy (cli_missing, model_unknown, ...) that `flows check`
    // preserves for the declarative dialect. This proves the propagated
    // AuthoredFlowExecutionError.refusalKind reaches the actual CLI output.
    const directory = temporaryDirectory();
    const dataDir = join(directory, 'data');
    await startDaemon(dataDir);

    const result = invokeCli([
      'run', BAD_MODEL_FLOW, '--input', '{}', '--data-dir', dataDir,
    ]);
    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('REFUSED [model_unknown]');
    expect(result.stderr).not.toContain('REFUSED [invalid_spec]');
    expect(result.stderr).toContain('declares model "unlisted-model"');
  });

  // `--no-spawn` keeps this case about the property it names. `flows run` now
  // starts a daemon when none is serving (kernel/DAEMON-LIFECYCLE.md §3), so
  // without the flag the refusal under test would be about the spawn rather
  // than about the authored BODY never being run.
  //
  // Trigger preflight (checkAuthoredTriggers) DOES import the authored
  // module before daemon-attach — trigger sources are only observable
  // after `flow(...).on(webhook(...))` has run — so the import-time
  // marker is expected to exist. The load-bearing invariant is that the
  // authored BODY does not run before the daemon is confirmed available;
  // the body-run marker path is what this test checks.
  it('does not run the authored body before daemon availability', () => {
    const directory = temporaryDirectory();
    const bodyMarker = join(directory, 'body-marker.txt');
    const importMarker = join(directory, 'import-marker.txt');
    const result = invokeCli([
      'run', '--no-spawn', SIDE_EFFECT_FLOW, '--input', JSON.stringify({ marker: bodyMarker }),
      '--data-dir', join(directory, 'absent-daemon'),
    ], { RELAYFLOWS_TEST_IMPORT_MARKER: importMarker });

    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('REFUSED [daemon_unreachable]');
    expect(existsSync(bodyMarker)).toBe(false);
  });

  it('refuses oversized file input before contacting relayflowd', () => {
    const directory = temporaryDirectory();
    const inputPath = join(directory, 'oversized.json');
    writeFileSync(inputPath, JSON.stringify({ value: 'x'.repeat(1_048_576) }));
    const result = invokeCli([
      'run', FLOW, '--input', inputPath, '--data-dir', join(directory, 'absent-daemon'),
    ]);

    expect(result.status, result.stderr).toBe(2);
    expect(result.stderr).toContain('REFUSED [input_too_large]');
    expect(result.stderr).not.toContain('daemon_unreachable');
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'flows-direct-input-'));
  temporaryDirectories.push(directory);
  return directory;
}

function invokeCli(args: string[], env: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [BUILT_CLI, ...args], {
    cwd: ROOT,
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
}

async function startDaemon(dataDir: string): Promise<void> {
  const daemon = spawn(RELAYFLOWD, ['--data-dir', dataDir, 'serve'], {
    cwd: ROOT,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  daemons.push(daemon);
  const socket = socketPathFor(dataDir);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (existsSync(socket)) return;
    if (daemon.exitCode !== null) throw new Error(`relayflowd exited ${daemon.exitCode}`);
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
  }
  throw new Error(`relayflowd did not create ${socket}`);
}

async function stopDaemon(daemon: ChildProcess): Promise<void> {
  if (daemon.exitCode !== null) return;
  daemon.kill('SIGTERM');
  await new Promise<void>((resolveStop) => {
    const timer = setTimeout(() => {
      daemon.kill('SIGKILL');
      resolveStop();
    }, 2_000);
    daemon.once('exit', () => {
      clearTimeout(timer);
      resolveStop();
    });
  });
}

function locateRelayflowd(): string {
  const direct = join(TOOLCHAIN_TARGET, 'debug', 'relayflowd');
  if (existsSync(direct)) return direct;
  if (existsSync(TOOLCHAIN_TARGET)) {
    const keyed = readdirSync(TOOLCHAIN_TARGET)
      .map((entry) => join(TOOLCHAIN_TARGET, entry, 'debug', 'relayflowd'))
      .filter((candidate) => existsSync(candidate))
      .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
    if (keyed[0] !== undefined) return keyed[0];
  }
  return join(ROOT, 'kernel', 'target', 'debug', 'relayflowd');
}

function requireExecutable(path: string, label: string): void {
  try {
    accessSync(path, constants.X_OK);
  } catch {
    throw new Error(`${label} is not executable at ${path}`);
  }
}
