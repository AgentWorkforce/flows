import { afterEach, expect, it } from 'vitest';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareDevinRuntime } from '../src/devin-runtime.js';
import { agentExecution, cliAdapterKind } from '../src/cli-adapter.js';
import { agentStepEnvironment } from '../src/step-secrets.js';
import { runAgentCli } from '../src/worker-cli.js';
import { probeCli, probeCliAsync } from '../src/cli/cli-probe.js';
import { preflight } from '../src/preflight.js';

const directories: string[] = [];
function directory() { const path = mkdtempSync(join(tmpdir(), 'devin-test-')); directories.push(path); return path; }
afterEach(() => { for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true }); });

it('isolates credentials and prompt files, escapes the key, and removes all private state', () => {
  const source = { HOME: '/original', XDG_DATA_HOME: '/original/data', DEVIN_API_KEY: 'test-"key\\value' };
  const prepared = prepareDevinRuntime(source, agentExecution('devin', '--version\nTask'));
  const credentials = join(prepared.env.XDG_DATA_HOME!, 'devin', 'credentials.toml');
  const prompt = prepared.args.at(-1)!;
  expect(readFileSync(credentials, 'utf8')).toBe(`windsurf_api_key = ${JSON.stringify(source.DEVIN_API_KEY)}\n`);
  expect(statSync(credentials).mode & 0o777).toBe(0o600);
  expect(statSync(prompt).mode & 0o777).toBe(0o600);
  expect(readFileSync(prompt, 'utf8')).toBe('--version\nTask');
  expect(prepared.env.HOME).toBe('/original');
  expect(prepared.env).not.toHaveProperty('DEVIN_API_KEY');
  expect(source.XDG_DATA_HOME).toBe('/original/data');
  prepared.close();
  expect(existsSync(credentials)).toBe(false);
  expect(existsSync(prompt)).toBe(false);
});

it('preserves local interactive login when no API key is supplied and rejects an empty key', () => {
  const local = prepareDevinRuntime({ XDG_DATA_HOME: '/local/data' });
  expect(local.env.XDG_DATA_HOME).toBe('/local/data'); local.close();
  expect(() => prepareDevinRuntime({ DEVIN_API_KEY: ' ' })).toThrow('must not be empty');
});

it('gives only Devin its intrinsic delivered login', () => {
  const source = { DEVIN_API_KEY: 'devin-login', OPENAI_API_KEY: 'openai-login',
    RELAY_SECRET_ENV_NAMES: '["DEVIN_API_KEY","OPENAI_API_KEY"]' };
  expect(cliAdapterKind('/bin/devin.exe')).toBe('devin');
  expect(agentStepEnvironment(source, 'devin')).toEqual({ DEVIN_API_KEY: 'devin-login' });
  expect(agentStepEnvironment(source, 'codex')).toEqual({ OPENAI_API_KEY: 'openai-login' });
});

it('refuses llm use before probing and warns about both unmetered ceilings for priced agent models', () => {
  let probes = 0;
  const options = { probes: { cli: () => { probes++; return { exists: true, authenticated: true }; },
    executor: () => true, command: () => true } };
  const refused = preflight({ version: '0.1.0', steps: [{ id: 'ask', type: 'llm', cli: 'devin', prompt: 'hello' }] }, options);
  expect(refused.ok).toBe(false); expect(probes).toBe(0);
  expect(refused.diagnostics).toContainEqual(expect.objectContaining({ kind: 'cli_unsupported' }));
  for (const budget of ['$1/run', { tokens: 100 }, undefined]) {
    const checked = preflight({ version: '0.1.0', budget,
      steps: [{ id: 'work', type: 'agent', cli: 'devin', model: 'gpt-5.6-sol', instruction: 'work' }] }, options);
    expect(checked.diagnostics).toContainEqual(expect.objectContaining({
      kind: 'budget_unmetered', message: expect.stringContaining('Token and dollar ceilings cannot bound its spend'),
    }));
  }
});

function fixture() {
  const cwd = directory(); const cli = join(cwd, 'devin');
  writeFileSync(cli, `#!/usr/bin/env node
const fs = require('node:fs'); const path = require('node:path');
const args = process.argv.slice(2);
if (args.includes('--help')) process.exit(0);
const credentials = path.join(process.env.XDG_DATA_HOME, 'devin', 'credentials.toml');
if (args[0] === 'models') process.exit(fs.existsSync(credentials) ? 0 : 1);
if (args.includes('--json') || args.includes('--relayflows-identify')) process.exit(10);
if (!args.includes('--prompt-file')) { console.log('RELAYFLOWS_MODEL_READY'); process.exit(0); }
const promptPath = args[args.indexOf('--prompt-file') + 1];
const task = fs.readFileSync(promptPath, 'utf8');
const result = { args, task, credentials, promptPath, keyPresent: !!process.env.DEVIN_API_KEY,
  credential: fs.readFileSync(credentials, 'utf8'), mode: fs.statSync(credentials).mode & 511 };
console.log(JSON.stringify(result));
if (task === 'wait') setTimeout(() => {}, 30000); else process.exit(task === 'fail' ? 7 : 0);
`, { mode: 0o755 });
  return { cwd, cli, env: { PATH: process.env.PATH, HOME: cwd, DEVIN_API_KEY: 'devin-test-secret' } };
}

it.each(['--version\nDo the task', 'fail'])('launches print mode with file input and cleans up after %s', async task => {
  const f = fixture();
  const result = await runAgentCli(f.cli, task, undefined, 'gpt-5.6-sol', undefined, undefined,
    'agent', undefined, f.cwd, 'direct', undefined, f.env);
  expect(result.exit_code).toBe(task === 'fail' ? 7 : 0);
  expect(result.tokens_input).toBeUndefined();
  expect(result.stdout_tail).not.toContain('devin-test-secret');
  const value = JSON.parse(result.stdout_tail);
  expect(value.task).toBe(task);
  expect(value.args).toEqual(expect.arrayContaining(['-p', '--permission-mode', 'dangerous',
    '--respect-workspace-trust', 'false', '--model', 'gpt-5.6-sol', '--prompt-file']));
  expect(value.keyPresent).toBe(false); expect(value.mode).toBe(0o600);
  expect(existsSync(value.credentials)).toBe(false); expect(existsSync(value.promptPath)).toBe(false);
});

it('checks provider auth with isolated credentials in both synchronous and asynchronous preflight', async () => {
  const f = fixture();
  expect(probeCli(f.cli, f.cwd, undefined, undefined, f.env).authenticated).toBe(true);
  expect((await probeCliAsync(f.cli, f.cwd, 'model', undefined, f.env)).modelAvailable).toBe(true);
  expect(probeCli(f.cli, f.cwd, undefined, undefined, { PATH: process.env.PATH, HOME: f.cwd,
    XDG_DATA_HOME: f.cwd }).authenticated).toBe(false);
});

it('removes credential and prompt state when the worker loses its lease', async () => {
  const f = fixture(); const privateRoot = directory();
  const controller = new AbortController();
  const running = runAgentCli(f.cli, 'wait', undefined, undefined, undefined, controller.signal,
    'agent', undefined, f.cwd, 'direct', undefined, { ...f.env, TMPDIR: privateRoot });
  for (let i = 0; i < 100 && readdirSync(privateRoot).length === 0; i++) {
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  expect(readdirSync(privateRoot).length).toBeGreaterThan(0);
  controller.abort();
  const result = await running;
  expect(result.exit_code).toBeNull();
  expect(result.transport?.cause).toBe('lease_lost');
  expect(readdirSync(privateRoot)).toEqual([]);
});
