import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { probeCli, probeCliAsync } from '../src/cli/cli-probe.js';
import { authoredNodeUtility } from '../src/authored-node-utility.js';
import * as adapters from '../src/cli-adapter.js';
import { runCli } from '../src/cli.js';

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

it('serves the exact model-scoped probe from the sealed authored runtime utility', async () => {
  const { path, directory } = wrapper(identify + 'process.exit(0)');
  await expect(authoredNodeUtility(['--probe-cli', path, 'exact-model', directory])).resolves.toMatchObject({
    exists: true,
    supported: true,
    authenticated: true,
    modelAvailable: true,
    executable: path,
  });
  await expect(authoredNodeUtility(['--probe-cli', path])).rejects.toThrow('requires exactly');
  await expect(authoredNodeUtility(['ordinary-authored-start'])).resolves.toBeUndefined();
});

it('returns the absolute executable selected for a bare CLI name', async () => {
  const { path, directory } = wrapper(identify + 'process.exit(0)');
  const previousPath = process.env.PATH;
  process.env.PATH = `${directory}:${previousPath ?? ''}`;
  try {
    await expect(probeCliAsync('wrapper', directory, 'exact-model')).resolves.toMatchObject({
      exists: true,
      executable: path,
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
      executable,
      modelAvailable: true,
    });
  } finally {
    process.chdir(previousCwd);
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});

it('routes the exact model-scoped probe through the ordinary Node CLI entry', async () => {
  const { path, directory } = wrapper(identify + 'process.exit(0)');
  const stdout: string[] = [];
  const stderr: string[] = [];
  await expect(runCli(['--probe-cli', path, 'exact-model', directory], {
    stdout: line => stdout.push(line),
    stderr: line => stderr.push(line),
  })).resolves.toBe(0);
  expect(stderr).toEqual([]);
  expect(JSON.parse(stdout.join('\n'))).toMatchObject({
    exists: true,
    supported: true,
    authenticated: true,
    modelAvailable: true,
    executable: path,
  });
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

it('reports timeout in both drivers while the async driver leaves the loop free', async () => {
  const { path, directory } = wrapper(identify + 'setTimeout(() => {}, 10_000);');
  const original = adapters.modelReadinessProbe;
  vi.spyOn(adapters, 'modelReadinessProbe').mockImplementation((kind, model) =>
    ({ ...original(kind, model), timeoutMs: 100 }));
  expect(() => probeCli(path, directory, 'test-model')).toThrow(expect.objectContaining({ detail: 'timeout:100ms' }));
  let ticked = false;
  const timer = setTimeout(() => { ticked = true; }, 20);
  await expect(probeCliAsync(path, directory, 'test-model')).rejects.toMatchObject({ detail: 'timeout:100ms' });
  clearTimeout(timer);
  expect(ticked).toBe(true);
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
