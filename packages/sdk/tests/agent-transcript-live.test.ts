import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { TRANSCRIPT_DIGEST_MAX_BYTES, type TranscriptDigest } from '../src/agent-transcript.js';
import { JournalClient } from '../src/journal-client.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { readAuthoredStepIndex } from '../src/authored-step-index.js';
import type { RunDiagnostic } from '../src/cli/run.js';

/**
 * The digest through the real kernel: the built CLI runs an authored flow with
 * the same argv Cloud's executor builds, against a real daemon, with a fake
 * `claude` that streams the captured fixture. What is asserted is read back
 * from the journal — `step.complete` was accepted with `trajectory_tail.
 * transcript` (no kernel change) and the file is where the digest says.
 */
const roots: string[] = [];
const sdk = resolve('.');
const cli = process.env['FLOWS_TEST_CLI'] ?? join(sdk, 'dist/cli.js');
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-stream-json-probe.jsonl');

function resolveDaemon(): string {
  if (process.env['RELAYFLOWD_BIN']) return process.env['RELAYFLOWD_BIN'];
  try {
    return join(JSON.parse(execFileSync('sh', [
      resolve('../../ops/cargo.sh'), 'metadata', '--format-version=1', '--no-deps', '--locked', '--offline',
    ], { cwd: resolve('../../kernel'), encoding: 'utf8',
      env: { ...process.env, RELAYFLOWS_NO_TOOLCHAIN_INSTALL: '1' },
    })).target_directory, 'debug', 'relayflowd');
  } catch (cause) {
    throw new Error('Live CLI tests require npm run test:prep or an explicit RELAYFLOWD_BIN.', { cause });
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    const connection = join(root, 'data/connection.json');
    if (existsSync(connection)) {
      const { pid } = JSON.parse(readFileSync(connection, 'utf8'));
      if (typeof pid === 'number') {
        try { process.kill(pid, 'SIGTERM'); } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
      }
    }
    rmSync(root, { recursive: true, force: true });
  }
});

/**
 * A fake `claude` (the adapter keys on the basename) that answers the auth
 * and readiness probes and, for the agent invocation, streams the fixture
 * with the result text replaced by `resultText`, exiting `exitCode`.
 */
function fixture(body: string, resultText: string, exitCode = 0, secret = '') {
  const relayflowd = resolveDaemon();
  const root = mkdtempSync(join(tmpdir(), 'flows-transcript-live-'));
  roots.push(root);
  symlinkSync(join(sdk, 'node_modules'), join(root, 'node_modules'));
  mkdirSync(join(root, 'bin'));
  const claude = join(root, 'bin', 'claude');
  const lines = readFileSync(FIXTURE, 'utf8').split('\n').filter(line => line.length > 0).map(line => {
    const frame = JSON.parse(line) as Record<string, unknown>;
    if (frame.type !== 'result') return line;
    return JSON.stringify({ ...frame, result: resultText, ...(exitCode === 0 ? {} : { is_error: true, subtype: 'error_during_execution' }) });
  });
  writeFileSync(claude, `#!/usr/bin/env node
if (process.argv[2] === 'auth') process.exit(0);
if (process.argv.includes('Reply with exactly RELAYFLOWS_MODEL_READY and nothing else.')) {
  process.stdout.write('RELAYFLOWS_MODEL_READY\\n'); process.exit(0);
}
process.stdout.write(${JSON.stringify(lines.join('\n') + '\n')});
process.stderr.write('stderr mentions ' + ${JSON.stringify(secret)} + '\\n');
process.exitCode = ${exitCode};
`);
  chmodSync(claude, 0o755);
  writeFileSync(join(root, 'flows.json'), JSON.stringify({ cli: claude, models: ['claude-haiku-4-5-20251001'] }));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'probe.flow.ts'), `import { flow } from '@relayflows/surface';\nexport default flow('probe', async f => {\n${body}\n});\n`);
  return {
    root,
    invoke: () => spawnSync(process.execPath,
      [cli, 'run', '--json', '--data-dir', join(root, 'data'), '--local-agent', 'probe.flow.ts', '--input', '{}'],
      { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...process.env, RELAYFLOWD_BIN: relayflowd, FAKE_TOKEN: secret } }),
  };
}

interface Entry { entry_type: string; step_id?: string; payload: { completionReason?: string; output?: unknown; trajectory_tail?: { transcript?: TranscriptDigest } } }

/**
 * Every `step.completed` across the root run's child runs (named in the
 * `authored-root` output on success) plus `extraRunIds`, keyed by step id,
 * with the run each came from.
 */
async function completions(root: string, rootRunId: string, extraRunIds: string[] = []) {
  const client = new JournalClient(socketPathFor(join(root, 'data')), { requestTimeoutMs: 5000 });
  await client.connect();
  await client.hello('transcript-live-test');
  try {
    const rootEntries = (await client.journalRead(rootRunId, 1, 1000)).entries as Entry[];
    const rootDone = rootEntries.find(e => e.entry_type === 'step.completed' && e.step_id === 'authored-root');
    const journalSteps = (rootDone?.payload.output as { journalSteps?: Array<{ id: string; runId: string }> } | undefined)?.journalSteps ?? [];
    const completed = new Map<string, Entry & { runId: string }>();
    for (const runId of [...journalSteps.map(step => step.runId), ...extraRunIds]) {
      for (const entry of (await client.journalRead(runId, 1, 1000)).entries as Entry[]) {
        if (entry.entry_type === 'step.completed' && entry.step_id !== undefined) completed.set(entry.step_id, { ...entry, runId });
      }
    }
    return completed;
  } finally {
    client.close();
  }
}

function runIdsIn(report: { runId?: string; diagnostics: Array<{ message: string }> }): string[] {
  const ids = new Set<string>();
  if (report.runId) ids.add(report.runId);
  for (const d of report.diagnostics) for (const m of d.message.matchAll(/\b(01[0-9A-HJKMNP-TV-Z]{24})\b/g)) ids.add(m[1]!);
  return [...ids];
}

describe('the transcript digest through the built CLI, a real daemon and the local agent', () => {
  it.each(['agent', 'llm'] as const)('preserves structured %s failure details and its completed root index', async kind => {
    const operation = kind === 'agent'
      ? "f.agent('prober', { task: 'probe', model: 'claude-haiku-4-5-20251001' })"
      : "f.llm('probe', { output: {}, model: 'claude-haiku-4-5-20251001' })";
    const f = fixture(`await ${operation}; f.done('success');`, 'probe failed', 1);
    const result = f.invoke();
    expect(result.status, result.stderr + result.stdout).toBe(1);
    const report = JSON.parse(result.stdout) as { runId: string; rootRunId: string; diagnostics: RunDiagnostic[] };
    expect(report.rootRunId).toBeTruthy();
    expect(report.rootRunId).not.toBe(report.runId);
    const failure = report.diagnostics.find(diagnostic => diagnostic.kind === 'step_failed');
    expect(failure).toMatchObject({ stepId: `${kind}-1`, stepType: kind, attempt: 1, maxIterations: 1 });
    if (kind === 'agent') expect(failure).toMatchObject({ exitCode: 1, stderrTail: 'stderr mentions \n' });
    expect(failure?.completionReason).toBeTruthy();
    const journal = new JournalClient(socketPathFor(join(f.root, 'data')));
    await journal.connect();
    await journal.hello('worker-failure-index-test');
    try {
      expect(await readAuthoredStepIndex(journal, report.rootRunId)).toEqual([{
        index: 'relayflows.authored-step.v1', step: `${kind}-1`, runId: report.runId,
        state: 'completed', completionReason: failure!.completionReason,
        // `f.agent`'s name is the step's label in the run's DAG; `f.llm` has none.
        ...(kind === 'agent' ? { label: 'prober' } : {}),
      }]);
    } finally { journal.close(); }
  }, 120_000);

  it('journals the digest in trajectory_tail on a successful agent step and writes the file it points at', async () => {
    const f = fixture(`
  const out = await f.agent('prober', { task: 'probe', model: 'claude-haiku-4-5-20251001' });
  if (out.summary !== 'probed ok' || out.artifacts.length !== 0) throw new Error('unexpected output: ' + JSON.stringify(out));
  f.done('success');`, 'probed ok');
    const result = f.invoke();
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const report = JSON.parse(result.stdout) as { runId: string; completionReason: string };
    expect(report.completionReason).toBe('success');

    const completed = await completions(f.root, report.runId);
    const { payload, runId } = completed.get('agent-1')!;
    expect(payload.completionReason).toBe('success');
    const transcript = payload.trajectory_tail!.transcript!;
    expect(transcript).toMatchObject({
      attempt: 1, exit_code: 0, final_text: 'probed ok',
      result: { provider: 'claude', model: 'claude-haiku-4-5-20251001', total_cost_usd: 0.027096100000000005, usage: { input: 18, output: 178, cache_read: 38341 } },
      tools: { counts: [{ name: 'Bash', calls: 1, errors: 0 }], total_calls: 1, shown_calls: 1 },
      artifacts: { count: 0, paths: [] },
    });
    expect(Buffer.byteLength(JSON.stringify(payload.trajectory_tail), 'utf8')).toBeLessThanOrEqual(TRANSCRIPT_DIGEST_MAX_BYTES);
    // The file is beside the PTY socket under the run's data dir, reduced.
    const file = transcript.file!;
    expect(file.path).toBe(join(f.root, 'data', 'runs', runId, 'steps', 'agent-1', 'attempt-1.transcript.jsonl'));
    expect(file).toMatchObject({ frames_total: 14, frames_kept: 14, truncated: false });
    const text = readFileSync(file.path, 'utf8');
    expect(text).toContain('"relayflow_reduced":true');
    expect(text).not.toContain('"apiKeySource"');
    // The digest is evidence, not output: the wrapper keeps its shape, and the
    // transcript file under the data dir is not one of the agent's artifacts.
    expect(payload.output).toEqual({
      exit_code: 0, stdout_tail: 'probed ok', stderr_tail: 'stderr mentions \n', artifacts: [], tokens_input: 18, tokens_output: 178,
    });
  }, 120_000);

  it('on a failed agent step, names the failure and the transcript in the terminal diagnostic, redacted', async () => {
    const secret = 'tok-0123456789abcdef';
    const f = fixture(`
  await f.agent('prober', { task: 'probe', model: 'claude-haiku-4-5-20251001' });
  f.done('success');`, `gave up: ${secret}`, 1, secret);
    const result = f.invoke();
    expect(result.status, result.stderr + result.stdout).toBe(1);
    const report = JSON.parse(result.stdout) as { runId: string; diagnostics: Array<{ kind: string; message: string }> };
    // An authored step's evidence reaches the root report as the child run's
    // rendered message (authored-flow-executor.ts), so it is read there.
    const failed = report.diagnostics.find(d => d.kind === 'step_failed')!;
    // `attempt=1/1` is read off the journal, not the spec: this step had one
    // attempt against a budget of one, which is what `retries_exhausted`-style
    // reasons mean and what the bare reason could not say.
    expect(failed.message).toContain('Step "agent-1" (agent) completionReason: worker_error attempt=1/1 transportRetries=1 exit=1');
    expect(failed.message).toContain('\nDetail: gave up: [redacted:FAKE_TOKEN]\n');
    const transcriptPath = /\nTranscript: (\S+attempt-1\.transcript\.jsonl)\n/.exec(failed.message)?.[1];
    expect(transcriptPath).toBe(join(f.root, 'data', 'runs', report.runId, 'steps', 'agent-1', 'attempt-1.transcript.jsonl'));

    const completed = await completions(f.root, report.runId, runIdsIn(report));
    const payload = completed.get('agent-1')!.payload;
    expect(payload.completionReason).toBe('worker_error');
    const transcript = payload.trajectory_tail!.transcript!;
    expect(transcript).toMatchObject({
      attempt: 1, exit_code: 1, failure: { kind: 'result', excerpt: 'gave up: [redacted:FAKE_TOKEN]' },
      result: { is_error: true, subtype: 'error_during_execution' },
    });
    // Nothing this change journals or writes carries the secret. (The worker's
    // `output` wrapper — stdout/stderr tails the daemon renders into
    // `verification.detail` — is the pre-existing, unredacted path.)
    expect(JSON.stringify(payload.trajectory_tail)).not.toContain(secret);
    expect(readFileSync(transcriptPath!, 'utf8')).not.toContain(secret);
  }, 120_000);
});
