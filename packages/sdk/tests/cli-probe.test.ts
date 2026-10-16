import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { probeCli, probeCliAsync, resolveExecutable } from '../src/cli/cli-probe.js';
import * as adapters from '../src/cli-adapter.js';
import { runCli } from '../src/cli.js';
import { checkAuthoredFlow } from '../src/cli/check.js';
import { authoredPreflight } from '../src/authored-preflight.js';
import type { FlowSpec } from '../src/spec.js';

const directories: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});
function wrapper(body: string) {
  const directory = mkdtempSync(join(tmpdir(), 'probe-drivers-'));
  directories.push(directory);
  const path = join(directory, 'wrapper');
  writeFileSync(path, '#!/usr/bin/env node\n' + body);
  chmodSync(path, 0o755);
  return { path, directory };
}
const identify = `if (process.argv[2] === '--relayflows-adapter-v1') {
  console.log('relayflows-agent-cli-v1'); process.exit(0);
}`;

it('does not expose the removed authored readiness probe through the public CLI', async () => {
  const stdout: string[] = [];
  const stderr: string[] = [];
  await expect(runCli(['--probe-cli', 'provider', 'model', '/tmp'], {
    stdout: line => stdout.push(line),
    stderr: line => stderr.push(line),
  })).resolves.toBe(2);
  expect(stdout).toEqual([]);
  expect(stderr.join('\n')).toContain('invalid_invocation');
});

it('returns the absolute executable selected for a bare CLI name', async () => {
  const { path, directory } = wrapper(identify + 'process.exit(0)');
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath ?? ''}`;
  try {
    await expect(probeCliAsync('wrapper', directory, 'exact-model')).resolves.toMatchObject({
      exists: true,
      executable: realpathSync(path),
      modelAvailable: true,
    });
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

it('binds the canonical target of a probed executable symlink', async () => {
  const { path, directory } = wrapper(identify + 'process.exit(0)');
  const link = join(directory, 'wrapper-link');
  symlinkSync(path, link);
  await expect(probeCliAsync(link, directory, 'exact-model')).resolves.toMatchObject({
    exists: true,
    executable: realpathSync(path),
    modelAvailable: true,
  });
});

it('executes a canonical shebang target through its authored alias in both probe drivers', async () => {
  const { path, directory } = wrapper(`
const { basename } = require('node:path');
process.exit(basename(process.argv[1]) === 'claude' ? 0 : 23);
`);
  const link = join(directory, 'claude');
  symlinkSync(path, link);
  const expected = {
    exists: true,
    executable: realpathSync(path),
    authenticated: true,
    modelAvailable: true,
  };
  expect(probeCli(link, directory, 'exact-model')).toMatchObject(expected);
  await expect(probeCliAsync(link, directory, 'exact-model')).resolves.toMatchObject(expected);
});

it('normalizes a relative executable returned by PATH lookup', async () => {
  const root = mkdtempSync(join(tmpdir(), 'relative-path-probe-'));
  directories.push(root);
  const bin = join(root, 'bin');
  mkdirSync(bin);
  const executable = join(bin, 'relative-wrapper');
  writeFileSync(executable, '#!/usr/bin/env node\n' + identify + 'process.exit(0)');
  chmodSync(executable, 0o755);
  const previousCwd = process.cwd();
  const previousPath = process.env.PATH;
  process.chdir(root);
  process.env.PATH = `./bin:${previousPath ?? ''}`;
  try {
    await expect(probeCliAsync('relative-wrapper', root, 'exact-model')).resolves.toMatchObject({
      exists: true,
      executable: realpathSync(executable),
      modelAvailable: true,
    });
  } finally {
    process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

it.each([
  ['success', 'process.exit(0)', { authenticated: true, modelAvailable: true }],
  ['model denied', "process.exit(process.env.RELAYFLOW_MODEL ? 1 : 0)", { authenticated: true, modelAvailable: false }],
  ['auth denied', "console.error('person@example.com sk-123456789abcdef'); process.exit(1)",
    { authenticated: false, modelAvailable: false, authExitCode: 1,
      authFailureDetail: '<redacted-email> <redacted-token>' }],
] as const)('keeps synchronous and asynchronous classification equal: %s', async (_name, body, expected) => {
  const { path, directory } = wrapper(identify + body);
  const sync = probeCli(path, directory, 'test-model');
  expect(sync).toMatchObject(expected);
  expect(await probeCliAsync(path, directory, 'test-model')).toEqual(sync);
});

it('keeps missing executables and unsupported identification fail closed', async () => {
  const { path, directory } = wrapper("console.log('not a wrapper')");
  expect(await probeCliAsync(path, directory)).toEqual(probeCli(path, directory));
  expect(await probeCliAsync('./missing', directory)).toEqual({ exists: false, authenticated: false });
  expect(await probeCliAsync('relayflows-no-such-executable', directory)).toEqual({ exists: false, authenticated: false });
});

it('uses an explicit provider environment for every probe process', async () => {
  const { path, directory } = wrapper(identify +
    "process.exit(process.env.ANTHROPIC_API_KEY === 'house-key' ? 0 : 1)");
  const environment = { ...process.env, ANTHROPIC_API_KEY: 'house-key' };
  expect(probeCli(path, directory, 'test-model', undefined, environment)).toMatchObject({
    authenticated: true, modelAvailable: true,
  });
  expect(await probeCliAsync(path, directory, 'test-model', undefined, environment)).toMatchObject({
    authenticated: true, modelAvailable: true,
  });
});

it('scopes delivered secrets in PATH lookup and provider probes for checked and authored steps', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'scoped-probe-'));
  directories.push(directory);
  const observed = join(directory, 'observed.jsonl');
  const claude = join(directory, 'claude');
  const which = join(directory, 'which');
  const record = `require('node:fs').appendFileSync(${JSON.stringify(observed)}, JSON.stringify({
  command: process.argv[1].split('/').at(-1),
  delivered: process.env.NATIVE_API_TOKEN ?? null,
  github: process.env.GH_TOKEN ?? null,
  bedrock: process.env.AWS_BEARER_TOKEN_BEDROCK ?? null,
  repository: process.env.GH_CONFIG_DIR ?? null,
  marker: process.env.RELAY_PLATFORM_AGENT_ENV_NAMES ?? null,
}) + '\\n');`;
  writeFileSync(claude, `#!/usr/bin/env node\n${record}\nprocess.exit(0);\n`);
  writeFileSync(which, `#!/usr/bin/env node\n${record}\nprocess.stdout.write(${JSON.stringify(claude + '\n')});\n`);
  chmodSync(claude, 0o755);
  chmodSync(which, 0o755);
  writeFileSync(join(directory, 'flows.json'), '{}');
  const environment = { ...process.env,
    PATH: `${directory}:${process.env.PATH ?? ''}`,
    NATIVE_API_TOKEN: 'user-secret', GH_TOKEN: 'user-github-secret',
    GH_CONFIG_DIR: '/trusted/gh', AWS_BEARER_TOKEN_BEDROCK: 'selected-bedrock-login',
    RELAY_SECRET_ENV_NAMES: '["NATIVE_API_TOKEN","GH_TOKEN","AWS_BEARER_TOKEN_BEDROCK"]',
    RELAY_PLATFORM_AGENT_ENV_NAMES: '["AWS_BEARER_TOKEN_BEDROCK"]',
  };
  const plain: FlowSpec = { version: '0.1.0', steps: [
    { id: 'agent', type: 'agent', cli: 'claude', instruction: 'task' },
  ] };
  expect(checkAuthoredFlow(plain, join(directory, 'plain.yaml'), undefined,
    { environment }).report.ok).toBe(true);
  const runPreflight = authoredPreflight(join(directory, 'plain.ts'), environment);
  expect((await runPreflight(plain)).report.ok).toBe(true);
  const records = () => readFileSync(observed, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as Record<string, string | null>);
  expect(records().some(record => record.command === 'which')).toBe(true);
  expect(records().some(record => record.command === 'claude')).toBe(true);
  for (const record of records()) {
    expect(record).toMatchObject({ delivered: null, github: null,
      bedrock: 'selected-bedrock-login', repository: '/trusted/gh', marker: null });
  }
  expect(resolveExecutable('claude', directory, environment)).toBe(realpathSync(claude));
  expect(records().at(-1)).toMatchObject({ command: 'which', delivered: null,
    github: null, bedrock: null, marker: null });
  const granted: FlowSpec = { ...plain, steps: [{ ...plain.steps[0]!, secrets: ['NATIVE_API_TOKEN'] }] };
  expect(checkAuthoredFlow(granted, join(directory, 'granted.yaml'), undefined,
    { environment }).report.ok).toBe(true);
  expect((await runPreflight(granted)).report.ok).toBe(true);
  expect(records().at(-1)?.delivered).toBe('user-secret');
});

it('reports timeout in both drivers while the async driver leaves the loop free', async () => {
  const observed = join(tmpdir(), `probe-alias-timeout-${process.pid}-${Date.now()}`);
  const { path: canonical, directory } = wrapper(identify + `
const { appendFileSync, existsSync } = require('node:fs');
process.on('SIGTERM', () => {
  appendFileSync(${JSON.stringify(observed)}, String(existsSync(process.argv[1])));
  process.removeAllListeners('SIGTERM');
  process.kill(process.pid, 'SIGTERM');
});
setTimeout(() => {}, 10_000);
`);
  directories.push(observed);
  const path = join(directory, 'timed-wrapper');
  symlinkSync(canonical, path);
  const original = adapters.modelReadinessProbe;
  vi.spyOn(adapters, 'modelReadinessProbe').mockImplementation((kind, model) =>
    ({ ...original(kind, model), timeoutMs: 100 }));
  expect(() => probeCli(path, directory, 'test-model')).toThrow(expect.objectContaining({ detail: 'timeout:100ms' }));
  expect(readFileSync(observed, 'utf8')).toBe('true');
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 20);
  await expect(probeCliAsync(path, directory, 'test-model')).rejects.toMatchObject({ detail: 'timeout:100ms' });
  clearTimeout(timer);
  expect(ticked).toBe(true);
  expect(readFileSync(observed, 'utf8')).toBe('truetrue');
});

it('reports signal termination in both drivers', async () => {
  const { path, directory } = wrapper(identify + "process.kill(process.pid, 'SIGTERM');");
  expect(() => probeCli(path, directory, 'test-model')).toThrow(expect.objectContaining({ detail: 'signal:SIGTERM' }));
  await expect(probeCliAsync(path, directory, 'test-model')).rejects.toMatchObject({ detail: 'signal:SIGTERM' });
});

// Verbatim outputs from Claude Code 2.1.278 and 2.1.281 answering the
// preflight model probe. The outdated CLI also prints its own catalog warning,
// which must not read as an unknown model.
const OUTDATED_STDOUT = "API Error: 400 Claude Code 2.1.278 does not support this model; version 2.1.280 or newer is required. Run 'claude update', or update the Claude desktop app, then try again.";
const CATALOG_WARNING = '"claude-opus-5-5" isn\'t described by this version\'s model catalog; update Claude Code.\n[claude-code:unrecognized_model] {"model":"claude-opus-5-5","query_source":"sdk"}';
const UNKNOWN_STDOUT = "There's an issue with the selected model (claude-opus-9-9). It may not exist or you may not have access to it. Run --model to pick a different model.";

function fakeClaude(stdout: string, stderr = '') {
  const directory = mkdtempSync(join(tmpdir(), 'probe-claude-'));
  directories.push(directory);
  const path = join(directory, 'claude');
  writeFileSync(path, `#!/usr/bin/env node
if (process.argv[2] === 'auth') process.exit(0);
process.stdout.write(${JSON.stringify(stdout)});
process.stderr.write(${JSON.stringify(stderr)});
process.exit(1);
`);
  chmodSync(path, 0o755);
  return { path, directory };
}

it.each([
  ['outdated CLI', OUTDATED_STDOUT, CATALOG_WARNING,
    { modelFailure: { cause: 'cli_outdated', requiredVersion: '2.1.280' }, modelFailureDetail: OUTDATED_STDOUT }],
  ['usage limit', "You've hit your limit · resets 3pm (UTC)", '',
    { modelFailure: { cause: 'provider_usage_limited' } }],
  ['rate limit', 'API Error: 429 {"type":"error","error":{"type":"rate_limit_error"}}', '',
    { modelFailure: { cause: 'provider_usage_limited' } }],
  ['unknown model', UNKNOWN_STDOUT, CATALOG_WARNING,
    { modelFailure: { cause: 'model_unknown' }, modelFailureDetail: UNKNOWN_STDOUT }],
  ['unrecognised output', 'API Error: 529 Overloaded', '', { modelFailureDetail: 'API Error: 529 Overloaded' }],
] as const)('classifies a failed claude model probe from its own output: %s', async (_name, stdout, stderr, expected) => {
  const { path, directory } = fakeClaude(stdout, stderr);
  const sync = probeCli(path, directory, 'claude-opus-5-5');
  expect(sync).toMatchObject({ authenticated: true, modelAvailable: false, modelExitCode: 1, ...expected });
  if (!('modelFailure' in expected)) expect(sync.modelFailure).toBeUndefined();
  expect(await probeCliAsync(path, directory, 'claude-opus-5-5')).toEqual(sync);
});
