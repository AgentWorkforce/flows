import { EventEmitter } from 'node:events';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { LLM_ERROR_MAX_BYTES, TRANSCRIPT_DIGEST_MAX_BYTES, type TranscriptDigest } from '../src/agent-transcript.js';
import type { JournalClient } from '../src/journal-client.js';
import { LlmWorker } from '../src/llm-worker.js';
import type { Pins } from '../src/protocol.js';
import { AgentWorker } from '../src/worker.js';
import { runAgentCli } from '../src/worker-cli.js';

/**
 * The transcript through the worker: a fake `claude` streams the captured
 * fixture, the spawn writes the per-attempt file beside the PTY socket, and
 * the digest lands in `trajectory_tail.transcript` — never in `output`.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-stream-json-probe.jsonl');
const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'flows-worker-transcript-'));
  directories.push(directory);
  return directory;
}

/** A fake `claude` that streams `lines` to stdout, `stderr` to stderr, and exits `code`. */
function fakeClaude(root: string, lines: string[], stderr = '', code = 0): string {
  const claude = join(root, 'claude');
  writeFileSync(claude, `#!/usr/bin/env node
process.stdout.write(${JSON.stringify(lines.join('\n') + '\n')});
process.stderr.write(${JSON.stringify(stderr)});
process.exitCode = ${code};
`);
  chmodSync(claude, 0o755);
  return claude;
}

function stubClient(): { client: JournalClient; completions: unknown[][] } {
  const completions: unknown[][] = [];
  const client = new EventEmitter() as EventEmitter & Record<string, unknown>;
  client.workerAttach = async () => ({});
  client.stepHeartbeat = async () => ({ lease_deadline_ms: Date.now() + 30_000 });
  client.stepComplete = async (...args: unknown[]) => { completions.push(args); return {}; };
  return { client: client as unknown as JournalClient, completions };
}

const fixtureLines = readFileSync(FIXTURE, 'utf8').split('\n').filter(line => line.length > 0);
const pins: Pins = { workspace: [], streams: [] };

describe('the spawn writes the attempt transcript and attaches the digest', () => {
  it('writes attempt-<n>.transcript.jsonl beside the PTY socket and points the digest at it', async () => {
    const root = makeDirectory();
    const dataDir = join(root, 'data');
    const claude = fakeClaude(root, fixtureLines);
    const result = await runAgentCli(claude, 'probe', undefined, undefined, undefined, undefined, 'agent',
      { dataDir, runId: 'run-1', stepId: 'step-1', attempt: 2, onDrive: () => {} }, root);

    expect(result).toMatchObject({ exit_code: 0, stdout_tail: 'done', tokens_input: 18, tokens_output: 178 });
    const transcript = result.transcript!;
    const path = join(dataDir, 'runs', 'run-1', 'steps', 'step-1', 'attempt-2.transcript.jsonl');
    expect(transcript.file).toMatchObject({ path, frames_total: 14, frames_kept: 14, truncated: false });
    expect(transcript.result?.model).toBe('claude-haiku-4-5-20251001');
    expect(transcript.tools?.total_calls).toBe(1);
    const written = readFileSync(path, 'utf8').split('\n').filter(line => line.length > 0);
    expect(written).toHaveLength(14);
    expect(written[6]).toContain('"relayflow_reduced":true');
    expect(written[6]).not.toContain('"cwd"');
    expect(JSON.parse(written[13]!)).toMatchObject({ type: 'result', result: 'done' });
  });

  it('writes no file without an attempt or a data dir, and still builds the digest', async () => {
    const root = makeDirectory();
    const claude = fakeClaude(root, fixtureLines);
    const withoutAttempt = await runAgentCli(claude, 'probe', undefined, undefined, undefined, undefined, 'agent',
      { dataDir: join(root, 'data'), runId: 'run-1', stepId: 'step-1', onDrive: () => {} }, root);
    expect(withoutAttempt.transcript?.file).toBeUndefined();
    expect(withoutAttempt.transcript?.final_text).toBe('done');
    expect(existsSync(join(root, 'data', 'runs', 'run-1', 'steps', 'step-1', 'attempt-1.transcript.jsonl'))).toBe(false);

    const withoutDataDir = await runAgentCli(claude, 'probe', undefined, undefined, undefined, undefined, 'llm');
    expect(withoutDataDir.transcript?.file).toBeUndefined();
    expect(withoutDataDir.transcript?.result?.session_id).toBe('41451e0a-96d1-4231-b85f-685f9a6187fe');
  });
});

describe('the agent worker journals the digest in trajectory_tail on every completion', () => {
  async function complete(root: string, claude: string, attempt: number) {
    const { client, completions } = stubClient();
    // The data dir is outside the agent's cwd, as it is in Cloud's sandbox
    // (`join(stateDir, "journal")`): the transcript file is not an artifact.
    mkdirSync(join(root, 'workspace'));
    // `cwd` is run-root-relative (flows#357), so the root the worker measures
    // it against is named here rather than being this process's directory.
    const worker = new AgentWorker(client, { workerId: 'w', pins, dataDir: join(root, 'data'), runRoot: root });
    const errors: unknown[] = [];
    worker.on('error', error => errors.push(error));
    await worker.attach();
    (client as unknown as EventEmitter).emit('step.dispatch', {
      run_id: 'run-a', step_id: 'agent-1', attempt, step_type: 'agent',
      spec: { cli: claude, instruction: 'probe', cwd: 'workspace' }, pins,
      lease_id: 'lease', lease_deadline_ms: Date.now() + 30_000, idempotency_key: 'k',
    });
    await worker.close();
    expect(errors).toEqual([]);
    expect(completions).toHaveLength(1);
    return completions[0]![5] as { output: unknown; trajectory_tail?: { transcript?: TranscriptDigest } };
  }

  it('on success: attempt, exit code, file pointer, artifacts, and no digest in output', async () => {
    const root = makeDirectory();
    const lines = fixtureLines.map(line => {
      const frame = JSON.parse(line) as Record<string, unknown>;
      // A text result, so the wrapper (not a parsed JSON object) is the output.
      return frame.type === 'result' ? JSON.stringify({ ...frame, result: 'wrote the file' }) : line;
    });
    const claude = fakeClaude(root, lines);
    const payload = await complete(root, claude, 3);

    const transcript = payload.trajectory_tail!.transcript!;
    expect(transcript).toMatchObject({ attempt: 3, exit_code: 0, final_text: 'wrote the file' });
    expect(transcript.file?.path).toBe(join(root, 'data', 'runs', 'run-a', 'steps', 'agent-1', 'attempt-3.transcript.jsonl'));
    expect(existsSync(transcript.file!.path)).toBe(true);
    expect(transcript.artifacts).toEqual({ count: 0, paths: [] });
    expect(Buffer.byteLength(JSON.stringify(payload.trajectory_tail), 'utf8')).toBeLessThanOrEqual(TRANSCRIPT_DIGEST_MAX_BYTES);
    // The wrapper output keeps its shape; the digest is evidence, not output.
    expect(payload.output).toMatchObject({ exit_code: 0, stdout_tail: 'wrote the file', artifacts: [] });
    expect(payload.output).not.toHaveProperty('transcript');
  });

  it('a step with no declared cwd spawns in the run root, not the worker process cwd', async () => {
    const root = makeDirectory();
    const marker = join(root, 'spawned-in');
    const claude = join(root, 'claude');
    writeFileSync(claude, `#!/usr/bin/env node
require('node:fs').writeFileSync(${JSON.stringify(marker)}, process.cwd());
process.stdout.write('done');
`);
    chmodSync(claude, 0o755);
    const { client, completions } = stubClient();
    const worker = new AgentWorker(client, { workerId: 'w', pins, dataDir: join(root, 'data'), runRoot: root });
    const errors: unknown[] = [];
    worker.on('error', error => errors.push(error));
    await worker.attach();
    (client as unknown as EventEmitter).emit('step.dispatch', {
      run_id: 'run-r', step_id: 'agent-1', attempt: 1, step_type: 'agent',
      spec: { cli: claude, instruction: 'probe' }, pins,
      lease_id: 'lease', lease_deadline_ms: Date.now() + 30_000, idempotency_key: 'k',
    });
    await worker.close();
    expect(errors).toEqual([]);
    expect(completions).toHaveLength(1);
    // The communication worker already substitutes runRoot for an absent cwd;
    // the CLI path must agree or the two workers run the same step in
    // different directories (cursor review on #512).
    expect(readFileSync(marker, 'utf8')).toBe(realpathSync(root));
  });

  it('on failure: the failure excerpt names the result frame, and the digest still rides', async () => {
    const root = makeDirectory();
    const lines = fixtureLines.map(line => {
      const frame = JSON.parse(line) as Record<string, unknown>;
      return frame.type === 'result'
        ? JSON.stringify({ ...frame, is_error: true, subtype: 'error_during_execution', result: 'budget exhausted' }) : line;
    });
    const claude = fakeClaude(root, lines, 'stderr noise', 1);
    const payload = await complete(root, claude, 1);
    expect(payload.trajectory_tail!.transcript).toMatchObject({
      attempt: 1, exit_code: 1, failure: { kind: 'result', excerpt: 'budget exhausted' },
      result: { is_error: true, subtype: 'error_during_execution' },
    });
    expect(payload.output).not.toHaveProperty('transcript');
  });
});

describe('the llm worker bounds and redacts its error and journals the digest', () => {
  it('cuts a 10 KiB stderr to 4 KiB, states the cut, and keeps the completion under the kernel cap', async () => {
    const root = makeDirectory();
    const secret = 'tok-0123456789abcdef';
    const stderr = `failed: ${secret}\n` + 'e'.repeat(10 * 1024);
    const claude = fakeClaude(root, [JSON.stringify({ type: 'system', subtype: 'init', model: 'm' })], stderr, 2);
    const { client, completions } = stubClient();
    const worker = new LlmWorker(client, 'llm');
    const errors: unknown[] = [];
    worker.on('error', error => errors.push(error));
    await worker.attach();
    const prior = process.env.FAKE_TOKEN;
    process.env.FAKE_TOKEN = secret;
    try {
      (client as unknown as EventEmitter).emit('step.dispatch', {
        run_id: 'run-l', step_id: 'llm-1', attempt: 1, step_type: 'llm',
        spec: { cli: claude, prompt: 'answer' }, pins,
        lease_id: 'lease', lease_deadline_ms: Date.now() + 30_000, idempotency_key: 'k',
      });
      await worker.close();
    } finally {
      if (prior === undefined) delete process.env.FAKE_TOKEN; else process.env.FAKE_TOKEN = prior;
    }
    expect(errors).toEqual([]);
    expect(completions[0]![4]).toBe('worker_error');
    const payload = completions[0]![5] as { trajectory_tail: { error: string; transcript: TranscriptDigest } };
    const { error, transcript } = payload.trajectory_tail;
    expect(error.startsWith('failed: [redacted:FAKE_TOKEN]\n')).toBe(true);
    expect(error).toMatch(/…\[\d+ bytes truncated\]$/);
    expect(Buffer.byteLength(error, 'utf8')).toBeLessThan(LLM_ERROR_MAX_BYTES + 64);
    expect(error).not.toContain(secret);
    // The default Claude model is priced, and this run reported no usage: the
    // decoder refuses the completion (exit null) and the digest says why.
    expect(transcript).toMatchObject({ attempt: 1, exit_code: null, result: { provider: 'claude', model: 'm' } });
    expect(transcript.failure?.kind).toBe('stderr');
    expect(transcript.failure?.excerpt).toContain('Priced model completion is missing token usage.');
    expect(transcript.failure?.excerpt).not.toContain(secret);
    expect(transcript.file).toBeUndefined();
    expect(Buffer.byteLength(JSON.stringify(payload.trajectory_tail), 'utf8')).toBeLessThan(16 * 1024);
  });
});
