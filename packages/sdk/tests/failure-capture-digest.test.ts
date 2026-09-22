import { describe, expect, it } from 'vitest';
import { buildTranscriptDigest, FAILURE_EXCERPT_MAX_BYTES, type TranscriptDigest } from '../src/agent-transcript.js';
import { decodeWrapperResult } from '../src/worker-usage.js';

const stream = 'ok - passing case\n'.repeat(80) + 'not ok 3 - the early failure\n'
  + 'ok - passing case\n'.repeat(2400) + '# fail 1\n';

describe('failure capture selection', () => {
  it.each(['result', 'tool_result', 'stderr'] as const)('keeps the early failure from %s', kind => {
    const frames = kind === 'result' ? [{ type: 'result', is_error: true, result: stream }]
      : kind === 'tool_result' ? [{ type: 'user', message: { content: [
        { type: 'tool_result', is_error: true, content: stream },
      ] } }] : [];
    const failure = buildTranscriptDigest(frames, 'claude', { exit_code: 1, stderr_tail: stream }, {}).failure!;
    expect(failure.kind).toBe(kind);
    expect(failure.excerpt).toContain('not ok 3 - the early failure');
    expect(failure.excerpt).toContain('# fail 1');
    expect(failure.truncated).toBe(true);
    expect(Buffer.byteLength(failure.excerpt)).toBeLessThanOrEqual(FAILURE_EXCERPT_MAX_BYTES);
    // status.ts applies DETAIL_LIMIT = 1024 characters to this display field.
    expect(failure.excerpt.slice(0, 1024)).toBe(failure.excerpt);
  });

  it('selects failure evidence on decoder refusal too', () => {
    const result = decodeWrapperResult({ exit_code: 0, stderr_tail: stream,
      stdout_tail: JSON.stringify({ protocol: 'relayflows-agent-cli-v1-result', output: 'done' }),
      transcript: {} as TranscriptDigest });
    expect(result.transcript!.failure!.excerpt).toContain('not ok 3 - the early failure');
    expect(Buffer.byteLength(result.transcript!.failure!.excerpt)).toBeLessThanOrEqual(FAILURE_EXCERPT_MAX_BYTES);
  });

  it.each(['result', 'tool_result', 'stderr'] as const)('redacts before selecting %s and sanitises control characters', kind => {
    const secret = 'a-secret-spanning-a-cut-0123456789';
    const text = '\u001b[31mFAILED ' + secret + '\n' + stream;
    const frames = kind === 'result' ? [{ type: 'result', is_error: true, result: text }]
      : kind === 'tool_result' ? [{ type: 'user', message: { content: [
        { type: 'tool_result', is_error: true, content: text },
      ] } }] : [];
    const failure = buildTranscriptDigest(frames, 'claude', { exit_code: 1, stderr_tail: text }, { TEST_SECRET: secret }).failure!;
    expect(failure.excerpt).toContain('[redacted:TEST_SECRET]');
    expect(failure.excerpt).not.toContain(secret);
    expect(failure.excerpt).not.toContain('\u001b');
  });
});
