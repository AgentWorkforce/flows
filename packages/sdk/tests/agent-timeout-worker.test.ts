import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runAgentCli } from '../src/worker-cli.js';
import { agentCompletionReason } from '../src/cli-transport-evidence.js';
import { workerSpend } from '../src/worker-spend.js';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function cli(name: string, source: string) {
  const root = mkdtempSync(join(tmpdir(), 'agent-timeout-worker-')); roots.push(root);
  const path = join(root, name);
  writeFileSync(path, `#!/usr/bin/env node\n${source}`); chmodSync(path, 0o755);
  return { root, path };
}

it.each(['claude', 'codex', 'wrapper'])('stops %s at its declared limit, preserving work and stopping descendants', async name => {
  const source = `
const { writeFileSync } = require('node:fs');
const { spawn } = require('node:child_process');
function work() {
  writeFileSync('work.txt', 'preserved');
  writeFileSync('pid', String(process.pid));
  spawn(process.execPath, ['-e', "require('node:fs').writeFileSync('descendant', String(process.pid)); setInterval(() => {}, 1000)"], { stdio: 'inherit' });
  setInterval(() => {}, 1000);
}
${name === 'wrapper' ? `process.stdout.write('relayflows-agent-cli-v1\\n');
process.stdin.resume(); process.stdin.on('end', () => {
  process.stdout.write('relayflows-agent-cli-v1-execute\\n'); work();
});` : 'process.stdin.resume(); work();'}
`;
  const f = cli(name, source);
  const result = await runAgentCli(f.path, 'repair', undefined, undefined, undefined,
    new AbortController().signal, 'agent', undefined, f.root, 'direct', undefined, process.env, undefined, 500);
  expect(agentCompletionReason(result)).toBe('timeout');
  expect(result.transport).toMatchObject({ phase: 'timeout', cause: 'timeout', retryable: false });
  expect(readFileSync(join(f.root, 'work.txt'), 'utf8')).toBe('preserved');
  for (const name of ['pid', 'descendant']) {
    const pid = Number(readFileSync(join(f.root, name), 'utf8'));
    // Linux may retain a dead descendant as a zombie until its init reaps it.
    try { process.kill(pid, 0); expect(readFileSync(`/proc/${pid}/stat`, 'utf8')).toMatch(/\) Z /); }
    catch (error) { expect((error as NodeJS.ErrnoException).code).toBe('ESRCH'); }
  }
}, 15000);

it('keeps timeout evidence when a priced wrapper has no usage', async () => {
  const f = cli('wrapper', `process.stdout.write('relayflows-agent-cli-v1\\n');
process.stdin.resume(); process.stdin.on('end', () => {
process.stdout.write('relayflows-agent-cli-v1-execute\\n'); setInterval(() => {}, 1000);
});`);
  const result = await runAgentCli(f.path, 'repair', undefined, 'claude-sonnet-4-6', undefined,
    new AbortController().signal, 'agent', undefined, f.root, 'direct', undefined, process.env, undefined, 50);
  expect(agentCompletionReason(result)).toBe('timeout');
  expect(result.stderr_tail).toMatch(/usage/i);
  // Never measured, so never journaled as a measured $0.
  expect(workerSpend(result, 'claude-sonnet-4-6').usage).toEqual({ tokens_in: 0, tokens_out: 0, dollars_unmetered: true });
});

it('keeps the usage a wrapper reported before it hung past its deadline', async () => {
  const envelope = JSON.stringify({ protocol: 'relayflows-agent-cli-v1-result', output: 'partial', usage: { input_tokens: 100, output_tokens: 20 } });
  const f = cli('wrapper', `process.stdout.write('relayflows-agent-cli-v1\\n');
process.stdin.resume(); process.stdin.on('end', () => {
process.stdout.write('relayflows-agent-cli-v1-execute\\n' + ${JSON.stringify(envelope)}); setInterval(() => {}, 1000);
});`);
  const result = await runAgentCli(f.path, 'repair', undefined, 'claude-opus-5', undefined,
    new AbortController().signal, 'agent', undefined, f.root, 'direct', undefined, process.env, undefined, 200);
  expect(agentCompletionReason(result)).toBe('timeout');
  expect(result).toMatchObject({ tokens_input: 100, tokens_output: 20, stdout_tail: '' });
  // claude-opus-5: 100 * $5/M + 20 * $25/M = $0.001000.
  expect(workerSpend(result, 'claude-opus-5').usage).toEqual({ tokens_in: 100, tokens_out: 20, dollars: '0.001000' });
});

it.each([
  ['handshake timeout', 'setInterval(() => {}, 1000);'],
  ['wrong identity', "process.stdout.write('not-a-wrapper\\n'); setInterval(() => {}, 1000);"],
  ['duplicate execute', "process.stdout.write('relayflows-agent-cli-v1\\n'); process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('relayflows-agent-cli-v1-execute\\nrelayflows-agent-cli-v1-execute\\n'));"],
  ['output limit', "process.stdout.write('relayflows-agent-cli-v1\\n'); process.stdin.resume(); process.stdin.on('end', () => process.stdout.write('relayflows-agent-cli-v1-execute\\n' + 'x'.repeat(1000)));"],
])('keeps %s a worker error despite a declared execution timeout', async (_, source) => {
  const f = cli('wrapper', source);
  const result = await runAgentCli(f.path, 'repair', undefined, undefined,
    { handshakeTimeoutMs: 200, maxOutputBytes: 128 }, new AbortController().signal,
    'agent', undefined, f.root, 'direct', undefined, process.env, undefined, 1000);
  expect(agentCompletionReason(result)).toBe('worker_error');
  expect(result.transport).toBeUndefined();
});
