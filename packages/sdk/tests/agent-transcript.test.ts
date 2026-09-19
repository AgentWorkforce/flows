import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ARTIFACT_PATHS_MAX,
  FAILURE_EXCERPT_MAX_BYTES,
  FINAL_TEXT_MAX_BYTES,
  TOOL_COUNTS_MAX,
  TOOL_LAST_CALLS_MAX,
  TRANSCRIPT_DIGEST_MAX_BYTES,
  TRANSCRIPT_FILE_MAX_BYTES,
  TRANSCRIPT_HEAD_BYTES,
  TRANSCRIPT_STRING_MAX_BYTES,
  boundTranscriptDigest,
  buildTranscriptDigest,
  digestBytes,
  openTranscriptWriter,
  redactText,
  reduceFrame,
  transcriptPath,
  type TranscriptDigest,
} from '../src/agent-transcript.js';
import { decodeProviderResult } from '../src/worker-usage.js';

/**
 * A real `claude --output-format stream-json --verbose` capture: 14 frames,
 * one Bash tool call, a `result` frame with cache tokens and the provider's
 * own cost. No secrets; the `init` frame carries local paths and inventory,
 * which is exactly what the writer is expected to drop.
 */
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-stream-json-probe.jsonl');
const fixtureLines = (): string[] => readFileSync(FIXTURE, 'utf8').split('\n').filter(line => line.length > 0);
const fixtureFrames = (): Array<Record<string, unknown>> => fixtureLines().map(line => JSON.parse(line) as Record<string, unknown>);

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });
function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'flows-transcript-'));
  directories.push(directory);
  return directory;
}

const ok = { exit_code: 0, stderr_tail: '' };

describe('redaction', () => {
  const env: NodeJS.ProcessEnv = {
    FAKE_TOKEN: 'tok-0123456789abcdef',
    S3_SECRET_ACCESS_KEY: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY',
    // Harmless name, secret value: only the shape rule can catch a dump of it.
    DEPLOY_TARGET: 'hunter2-hunter2-hunter2',
    SHORT_KEY: 'abc',
    HOME: '/home/agent',
  };

  it('replaces the values of secret-named variables wherever they appear', () => {
    const text = `curl -H "x: ${env.FAKE_TOKEN}" and ${env.S3_SECRET_ACCESS_KEY} again ${env.FAKE_TOKEN}`;
    const out = redactText(text, env);
    expect(out).toBe('curl -H "x: [redacted:FAKE_TOKEN]" and [redacted:S3_SECRET_ACCESS_KEY] again [redacted:FAKE_TOKEN]');
    // Too short to be worth matching by value: it would redact every "abc".
    expect(redactText('abc abc', env)).toBe('abc abc');
  });

  it('redacts an env dump by shape whatever the variable is called', () => {
    const dump = `HOME=/home/agent\nDEPLOY_TARGET=${env.DEPLOY_TARGET}\nFAKE_TOKEN=${env.FAKE_TOKEN}\nOTHER=not-in-env\n`;
    expect(redactText(dump, env)).toBe(
      'HOME=[redacted:HOME]\nDEPLOY_TARGET=[redacted:DEPLOY_TARGET]\nFAKE_TOKEN=[redacted:FAKE_TOKEN]\nOTHER=not-in-env\n');
  });

  it('redacts well-known token shapes, header values and private keys, keeping the names', () => {
    const cases: Array<[string, string]> = [
      ['key sk-ant-api03-abcdefghijklmnop', 'key [redacted]'],
      ['ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789', '[redacted]'],
      ['github_pat_11ABCDEFG0123456789_abcdefghijklmnop', '[redacted]'],
      ['xoxb-1234567890-abcdefgh', '[redacted]'],
      ['AKIAIOSFODNN7EXAMPLE', '[redacted]'],
      ['at_live_abcdefghijklmnop', '[redacted]'],
      ['Authorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload.sig', 'Authorization: Bearer [redacted]'],
      ['"authorization": "Bearer abcdefghijklmnop"', '"authorization": "Bearer [redacted]"'],
      ['x-api-key=abcdefghijklmnop', 'x-api-key=[redacted]'],
      ['x-callback-token: cb_abcdefghijklmnop', 'x-callback-token: [redacted]'],
      ['Cookie: session=abc; other=def', 'Cookie: [redacted]'],
      ['-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----', '[redacted:private-key]'],
    ];
    for (const [input, expected] of cases) expect(redactText(input, env)).toBe(expected);
  });

  it('leaves journal keys that merely resemble a relay token prefix alone', () => {
    expect(redactText('{"at_ms":1,"br_x":2}', env)).toBe('{"at_ms":1,"br_x":2}');
  });
});

describe('frame reduction', () => {
  it('reduces the init frame to its whitelist and says so', () => {
    const init = fixtureFrames().find(f => f.type === 'system' && f.subtype === 'init')!;
    expect(Object.keys(init)).toEqual(expect.arrayContaining(['cwd', 'tools', 'slash_commands', 'apiKeySource', 'memory_paths', 'messaging_socket_path']));
    const reduced = reduceFrame(init, text => text) as Record<string, unknown>;
    expect(reduced).toEqual({
      relayflow_reduced: true, type: 'system', subtype: 'init', model: 'claude-haiku-4-5-20251001',
      claude_code_version: '2.1.278', permissionMode: 'default', session_id: '41451e0a-96d1-4231-b85f-685f9a6187fe',
      tools_count: 196, mcp_servers_count: 6,
    });
  });

  it('bounds every string leaf and states the cut inside the value', () => {
    const big = 'x'.repeat(TRANSCRIPT_STRING_MAX_BYTES + 1000);
    const frame = { type: 'user', message: { content: [{ type: 'tool_result', content: big }] } };
    const reduced = reduceFrame(frame, text => text) as typeof frame;
    const content = reduced.message.content[0]!.content;
    expect(content.endsWith('…[relayflow: 1000 bytes truncated]')).toBe(true);
    expect(Buffer.byteLength(content, 'utf8')).toBeLessThan(TRANSCRIPT_STRING_MAX_BYTES + 64);
  });
});

describe('transcript file writer', () => {
  it('names the file by attempt beside the PTY socket and validates ids', () => {
    expect(transcriptPath({ dataDir: '/d', runId: 'run', stepId: 'step' }, 3)).toBe('/d/runs/run/steps/step/attempt-3.transcript.jsonl');
    expect(() => transcriptPath({ dataDir: '/d', runId: '../x', stepId: 'step' }, 1)).toThrow(/Invalid sidechannel path component/);
    expect(() => transcriptPath({ dataDir: '/d', runId: 'run', stepId: 'step' }, 0)).toThrow(/Invalid transcript attempt/);
  });

  it('keeps a 3 MiB stream under 1 MiB: whole head, rolling tail, one marker at the seam', async () => {
    const path = join(makeDirectory(), 'attempt-1.transcript.jsonl');
    const writer = (await openTranscriptWriter(path, {}))!;
    const frame = (i: number): string => JSON.stringify({ type: 'assistant', seq: i, message: { content: [{ type: 'text', text: 'y'.repeat(1000) }] } });
    const total = 3000; // ≈ 3 MiB of ~1 KiB lines
    for (let i = 0; i < total; i += 1) writer.write(frame(i));
    const file = (await writer.close())!;

    expect(file.frames_total).toBe(total);
    expect(file.truncated).toBe(true);
    expect(file.bytes_total).toBeGreaterThan(3 * 1024 * 1024);
    expect(file.bytes_kept).toBeLessThanOrEqual(TRANSCRIPT_FILE_MAX_BYTES);
    const lines = readFileSync(path, 'utf8').split('\n').filter(line => line.length > 0);
    const markerIndex = lines.findIndex(line => line.includes('"relayflow.truncated"'));
    expect(markerIndex).toBeGreaterThan(0);
    const marker = JSON.parse(lines[markerIndex]!) as { type: string; bytes_dropped: number; frames_dropped: number };
    expect(marker).toEqual({ type: 'relayflow.truncated', bytes_dropped: file.bytes_total - file.bytes_kept, frames_dropped: total - file.frames_kept });
    expect(lines).toHaveLength(file.frames_kept + 1);
    // The head is contiguous from the first frame; the tail ends at the last.
    expect(JSON.parse(lines[0]!).seq).toBe(0);
    expect(JSON.parse(lines[markerIndex - 1]!).seq).toBe(markerIndex - 1);
    expect(JSON.parse(lines[markerIndex + 1]!).seq).toBe(markerIndex - 1 + marker.frames_dropped + 1);
    expect(JSON.parse(lines.at(-1)!).seq).toBe(total - 1);
    const headBytes = lines.slice(0, markerIndex).reduce((sum, line) => sum + Buffer.byteLength(line) + 1, 0);
    expect(headBytes).toBeLessThanOrEqual(TRANSCRIPT_HEAD_BYTES);
    expect(statSync(path).size).toBe(file.bytes_kept + Buffer.byteLength(lines[markerIndex]!) + 1);
    expect(file.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it('writes a small stream whole, reduced and redacted, and describes it exactly', async () => {
    const path = join(makeDirectory(), 'attempt-1.transcript.jsonl');
    const env = { FAKE_TOKEN: 'tok-0123456789abcdef', DEPLOY_TARGET: 'hunter2-hunter2-hunter2' };
    const writer = (await openTranscriptWriter(path, env))!;
    for (const line of fixtureLines()) writer.write(line);
    writer.write(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2',
      content: `FAKE_TOKEN=${env.FAKE_TOKEN}\nDEPLOY_TARGET=${env.DEPLOY_TARGET}\nsaw ${env.FAKE_TOKEN} in a log` }] } }));
    writer.write('not json at all ' + env.FAKE_TOKEN);
    const file = (await writer.close())!;

    const text = readFileSync(path, 'utf8');
    expect(text).not.toContain(env.FAKE_TOKEN);
    expect(text).not.toContain(env.DEPLOY_TARGET);
    expect(text).toContain('FAKE_TOKEN=[redacted:FAKE_TOKEN]\\nDEPLOY_TARGET=[redacted:DEPLOY_TARGET]\\nsaw [redacted:FAKE_TOKEN] in a log');
    expect(text).toContain('not json at all [redacted:FAKE_TOKEN]');
    expect(text).not.toContain('"cwd"');
    expect(text).not.toContain('apiKeySource');
    expect(text).toContain('"relayflow_reduced":true');
    expect(file).toMatchObject({ path, frames_total: 16, frames_kept: 16, truncated: false });
    expect(file.bytes_kept).toBe(file.bytes_total);
    expect(statSync(path).size).toBe(file.bytes_kept);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('reports no file when the path cannot be opened', async () => {
    const directory = makeDirectory();
    expect(await openTranscriptWriter(join(directory, 'missing', '\0bad'), {})).toBeUndefined();
  });
});

describe('transcript digest', () => {
  it('reports the provider result, tool calls and final text from the fixture frames', () => {
    const digest = buildTranscriptDigest(fixtureFrames(), 'claude', ok, {});
    expect(digest.result).toEqual({
      provider: 'claude', model: 'claude-haiku-4-5-20251001', claude_code_version: '2.1.278',
      session_id: '41451e0a-96d1-4231-b85f-685f9a6187fe', subtype: 'success', is_error: false, stop_reason: 'end_turn',
      num_turns: 2, duration_ms: 4579, duration_api_ms: 3534, total_cost_usd: 0.027096100000000005,
      usage: { input: 18, output: 178, cache_read: 38341, cache_creation: 11177, thinking: 90 },
      permission_denials: 0,
    });
    expect(digest.tools).toEqual({
      counts: [{ name: 'Bash', calls: 1, errors: 0 }],
      last_calls: [{ seq: 1, name: 'Bash', input_excerpt: expect.stringContaining('echo frame-probe'), result_bytes: expect.any(Number) }],
      total_calls: 1, shown_calls: 1, complete: true,
    });
    expect(digest.final_text).toBe('done');
    expect(digest.failure).toBeUndefined();
  });

  it('is what decodeProviderResult attaches beside the metered usage', () => {
    const decoded = decodeProviderResult({ exit_code: 0, stdout_tail: fixtureLines().join('\n'), stderr_tail: '' }, 'claude', {});
    expect(decoded).toMatchObject({ exit_code: 0, stdout_tail: 'done', tokens_input: 18, tokens_output: 178 });
    expect(decoded.transcript?.result?.total_cost_usd).toBeCloseTo(0.0271, 4);
    expect(decoded.transcript?.tools?.total_calls).toBe(1);
  });

  it('picks the failure in order: result frame, then the last failed tool result, then stderr', () => {
    const frames = fixtureFrames();
    const failedResult = frames.map(f => f.type === 'result' ? { ...f, is_error: true, subtype: 'error_during_execution', result: 'boom' } : f);
    expect(buildTranscriptDigest(failedResult, 'claude', { exit_code: 1, stderr_tail: 'ignored' }, {}).failure)
      .toEqual({ kind: 'result', excerpt: 'boom' });

    const toolError = frames.map(f => f.type === 'user'
      ? { ...f, message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_01JpDmDUaeRcY6pxHiJhg8ZP', content: 'permission denied', is_error: true }] } }
      : f);
    const digest = buildTranscriptDigest(toolError, 'claude', { exit_code: 1, stderr_tail: 'ignored' }, {});
    expect(digest.failure).toEqual({ kind: 'tool_result', excerpt: 'permission denied' });
    expect(digest.tools?.counts).toEqual([{ name: 'Bash', calls: 1, errors: 1 }]);
    expect(digest.tools?.last_calls[0]).toMatchObject({ is_error: true });

    expect(buildTranscriptDigest(frames, 'claude', { exit_code: 1, stderr_tail: 'x'.repeat(3000) + 'last' }, {}).failure)
      .toEqual({ kind: 'stderr', excerpt: 'x'.repeat(FAILURE_EXCERPT_MAX_BYTES - 4) + 'last' });
    // A successful attempt has no failure to report, whatever the frames say.
    expect(buildTranscriptDigest(toolError, 'claude', ok, {}).failure).toBeUndefined();
  });

  it('redacts what it lifts from the frames', () => {
    const env = { FAKE_TOKEN: 'tok-0123456789abcdef' };
    const frames = fixtureFrames().map(f => {
      if (f.type === 'result') return { ...f, result: `done with ${env.FAKE_TOKEN}` };
      if (f.type === 'assistant') {
        const message = f.message as { content: Array<Record<string, unknown>> };
        return { ...f, message: { ...message, content: message.content.map(block =>
          block.type === 'tool_use' ? { ...block, input: { command: `curl -H 'x: ${env.FAKE_TOKEN}'` } } : block) } };
      }
      return f;
    });
    const digest = buildTranscriptDigest(frames, 'claude', ok, env);
    expect(digest.final_text).toBe('done with [redacted:FAKE_TOKEN]');
    expect(digest.tools?.last_calls[0]?.input_excerpt).toContain('[redacted:FAKE_TOKEN]');
    expect(JSON.stringify(digest)).not.toContain(env.FAKE_TOKEN);
  });

  it('counts Codex items by type and marks the tool summary incomplete', () => {
    const frames = [
      { type: 'item.completed', item: { type: 'command_execution', command: 'ls' } },
      { type: 'item.completed', item: { type: 'command_execution', command: 'cat' } },
      { type: 'item.completed', item: { type: 'agent_message', text: 'all good' } },
      { type: 'turn.completed', usage: { input_tokens: 5, output_tokens: 2, cached_input_tokens: 1 } },
    ];
    const digest = buildTranscriptDigest(frames, 'codex', ok, {});
    expect(digest.result).toEqual({ provider: 'codex', usage: { input: 5, output: 2, cache_read: 1 } });
    expect(digest.tools).toEqual({ counts: [{ name: 'command_execution', calls: 2, errors: 0 }], last_calls: [], total_calls: 2, shown_calls: 0, complete: false });
    expect(digest.final_text).toBe('all good');
  });

  it('keeps 500 tool calls, 50 artifacts and full texts within 8 KiB, stating every cut', () => {
    const frames: Array<Record<string, unknown>> = [{ type: 'system', subtype: 'init', model: 'm', session_id: 's' }];
    for (let i = 0; i < 500; i += 1) {
      frames.push({ type: 'assistant', message: { content: [{ type: 'tool_use', id: `t${i}`, name: `Tool${i}`, input: { path: `/very/long/path/number/${i}/`.repeat(4) } }] } });
      frames.push({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: `t${i}`, content: 'r'.repeat(500), is_error: i % 7 === 0 }] } });
    }
    frames.push({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'f'.repeat(5000), usage: { input_tokens: 1, output_tokens: 1 } });
    const built = buildTranscriptDigest(frames, 'claude', { exit_code: 1, stderr_tail: '' }, {});
    expect(built.tools).toMatchObject({ total_calls: 500, shown_calls: TOOL_LAST_CALLS_MAX });
    expect(built.tools?.counts).toHaveLength(TOOL_COUNTS_MAX);
    expect(built.final_text_truncated).toBe(true);
    expect(Buffer.byteLength(built.final_text!, 'utf8')).toBeLessThan(FINAL_TEXT_MAX_BYTES + 64);
    expect(built.failure?.truncated).toBe(true);

    const unbounded: TranscriptDigest = {
      attempt: 1, exit_code: 1, ...built,
      artifacts: { count: 80, paths: Array.from({ length: ARTIFACT_PATHS_MAX }, (_, i) => `src/generated/module-${i}.ts`) },
    };
    expect(digestBytes(unbounded)).toBeGreaterThan(TRANSCRIPT_DIGEST_MAX_BYTES);
    const bounded = boundTranscriptDigest(unbounded);
    expect(digestBytes(bounded)).toBeLessThanOrEqual(TRANSCRIPT_DIGEST_MAX_BYTES);
    // Every cut is visible on the digest itself.
    expect(bounded.tools!.shown_calls).toBeLessThan(bounded.tools!.total_calls);
    expect(bounded.tools!.last_calls).toHaveLength(bounded.tools!.shown_calls);
    expect(bounded.artifacts!.paths.length).toBeLessThan(bounded.artifacts!.count);
    expect(bounded.final_text_truncated).toBe(true);
    expect(bounded.failure?.truncated).toBe(true);
    // What survives is still the account: the result and the counts.
    expect(bounded.result?.model).toBe('m');
    expect(bounded.tools!.counts.length).toBeGreaterThan(0);
    expect(bounded.attempt).toBe(1);
  });

  it('leaves a digest that already fits untouched', () => {
    const digest = { attempt: 1, exit_code: 0, ...buildTranscriptDigest(fixtureFrames(), 'claude', ok, {}) };
    expect(boundTranscriptDigest(digest)).toEqual(digest);
  });
});
