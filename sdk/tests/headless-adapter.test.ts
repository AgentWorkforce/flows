import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { agentExecution, HEADLESS_PROMPT_FILE } from '../src/cli-adapter.js';
import { parseHeadlessOutput } from '../src/headless-adapter.js';
import { runAgentCli } from '../src/worker-cli.js';

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe('SDK-owned provider headless adapters', () => {
  it('keeps a huge Claude instruction off argv, parses trajectory/usage/session/subagents', async () => {
    const directory = temporaryDirectory();
    const evidence = join(directory, 'evidence.json');
    const claude = executable(directory, 'claude', `
let prompt = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', chunk => { prompt += chunk; });
process.stdin.on('end', () => {
  require('node:fs').writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ argv: process.argv.slice(2), prompt }));
  console.log(JSON.stringify({ type: 'assistant', message: { content: [] } }));
  console.log(JSON.stringify({ type: 'result', result: 'finished', session_id: 'session-1', usage: { input_tokens: 12, output_tokens: 4 }, total_cost_usd: 0.003, subagent_stats: { spawned: 2 } }));
});
`);
    const prompt = 'x'.repeat(1_000_000);

    const result = await runAgentCli(claude, prompt, undefined, 'claude-test-model');

    expect(result.exit_code).toBe(0);
    expect(result.headless).toEqual({
      finalText: 'finished',
      trajectory: [
        { type: 'assistant', message: { content: [] } },
        expect.objectContaining({ type: 'result', result: 'finished' }),
      ],
      usage: { tokens_in: 12, tokens_out: 4, dollars: '0.003' },
      sessionId: 'session-1',
      subagents: { spawned: 2 },
    });
    const received = JSON.parse(readFileSync(evidence, 'utf8')) as { argv: string[]; prompt: string };
    expect(received.argv).toEqual([
      '-p', '--output-format', 'stream-json', '--verbose', '--model', 'claude-test-model',
    ]);
    expect(received.argv.join(' ')).not.toContain(prompt.slice(0, 100));
    expect(received.prompt).toHaveLength(prompt.length);
  });

  it('fails closed when Claude exits zero with malformed structured output or no final message', async () => {
    const directory = temporaryDirectory();
    const malformed = executable(directory, 'claude', 'console.log("not-json")');
    const malformedResult = await runAgentCli(malformed, 'do work', undefined);
    expect(malformedResult).toMatchObject({ exit_code: null });
    expect(malformedResult.stderr_tail).toContain('malformed structured JSON');

    // The basename selects the provider. A separate directory avoids changing
    // the malformed fixture the prior assertion is evidence for.
    const providerDirectory = temporaryDirectory();
    const provider = executable(providerDirectory, 'claude', 'console.log(JSON.stringify({ type: "assistant" }))');
    const noFinalResult = await runAgentCli(provider, 'do work', undefined);
    expect(noFinalResult).toMatchObject({ exit_code: null });
    expect(noFinalResult.stderr_tail).toContain('without a readable final');
  });

  it('reports a crashed provider process as worker failure material instead of throwing', async () => {
    const directory = temporaryDirectory();
    const claude = executable(directory, 'claude', 'process.kill(process.pid, "SIGKILL")');

    const result = await runAgentCli(claude, 'do work', undefined);

    expect(result.exit_code).toBeNull();
    expect(result.headless).toBeUndefined();
  });

  it('uses Codex stdin with the non-Git rail and accepts its final agent message', () => {
    const invocation = agentExecution('codex', 'never on argv', 'gpt-test-model');
    expect(invocation).toEqual({
      args: ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--model', 'gpt-test-model', '-'],
      timeoutMs: 0,
      stdin: 'never on argv',
    });
    expect(parseHeadlessOutput('codex', [
      JSON.stringify({ type: 'thread.started', thread_id: 'thread-1' }),
      JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'final' } }),
      JSON.stringify({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 3 } }),
    ].join('\n'))).toEqual({
      finalText: 'final',
      trajectory: expect.any(Array),
      usage: { tokens_in: 7, tokens_out: 3, dollars: '0' },
      sessionId: 'thread-1',
    });
  });

  it('uses a private Grok prompt file and deletes it after its zero-exit result', async () => {
    const directory = temporaryDirectory();
    const evidence = join(directory, 'grok-evidence.json');
    const grok = executable(directory, 'grok', `
const fs = require('node:fs');
const index = process.argv.indexOf('--prompt-file');
const path = process.argv[index + 1];
fs.writeFileSync(${JSON.stringify(evidence)}, JSON.stringify({ argv: process.argv.slice(2), path, prompt: fs.readFileSync(path, 'utf8') }));
console.log(JSON.stringify({ text: 'grok final', sessionId: 'grok-session', usage: { input_tokens: 5, output_tokens: 2 }, total_cost_usd: '0.004' }));
`);

    const result = await runAgentCli(grok, 'private instruction', undefined, HEADLESS_PROMPT_FILE);

    expect(result).toMatchObject({ exit_code: 0, headless: { finalText: 'grok final', sessionId: 'grok-session' } });
    const received = JSON.parse(readFileSync(evidence, 'utf8')) as { argv: string[]; path: string; prompt: string };
    expect(received.argv).toEqual(['--prompt-file', received.path, '--output-format', 'json', '--model', HEADLESS_PROMPT_FILE]);
    expect(received.prompt).toBe('private instruction');
    expect(() => readFileSync(received.path, 'utf8')).toThrow();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'flows-headless-adapter-'));
  directories.push(directory);
  return directory;
}

function executable(directory: string, name: string, body: string): string {
  const path = join(directory, name);
  writeFileSync(path, `#!/usr/bin/env node\n${body}`);
  chmodSync(path, 0o755);
  return path;
}
