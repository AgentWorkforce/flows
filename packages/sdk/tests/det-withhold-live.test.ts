import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, expect, it } from 'vitest';
import { socketPathFor } from '../src/daemon-connection.js';

/**
 * Real SDK, real kernel, FAKE credentials only, in Cloud's shape: the host
 * starts `relayflowd serve --det-withhold <names>` itself, then runs
 * `flows run --local-agent` with agent keys in the CLI env. A fake `claude`
 * (the adapter keys on the basename, so it takes the real adapter env path)
 * and an `f.run` step each dump their own environment.
 */
const sdk = resolve('.');
const cli = process.env['FLOWS_TEST_CLI'] ?? join(sdk, 'dist/cli.js');
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-stream-json-probe.jsonl');
const MODEL = 'claude-haiku-4-5-20251001';
const AGENT: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-fixtureAgentOnly-5Tz8Lm2Q',
  OPENAI_API_KEY: 'sk-fixtureAgentOnly-openai-3Kd1Vb7',
};
const ORDINARY: Record<string, string> = { DELIVERED_SECRET: 'delivered-fixture-value-81Jx' };
const roots: string[] = [];
const daemons: ChildProcess[] = [];

function resolveDaemon(): string {
  if (process.env['RELAYFLOWD_BIN']) return process.env['RELAYFLOWD_BIN'];
  return join(JSON.parse(execFileSync('sh', [
    resolve('../../ops/cargo.sh'), 'metadata', '--format-version=1', '--no-deps', '--locked', '--offline',
  ], { cwd: resolve('../../kernel'), encoding: 'utf8',
    env: { ...process.env, RELAYFLOWS_NO_TOOLCHAIN_INSTALL: '1' },
  })).target_directory, 'debug', 'relayflowd');
}

afterEach(() => {
  for (const daemon of daemons.splice(0)) {
    try { process.kill(-daemon.pid!, 'SIGKILL'); } catch { /* already gone */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function baseEnv(home: string): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: home };
  for (const name of ['TMPDIR', 'XDG_RUNTIME_DIR']) if (process.env[name]) env[name] = process.env[name]!;
  return env;
}

async function startDaemon(root: string, dataDir: string, args: string[]): Promise<void> {
  const daemon = spawn(resolveDaemon(), ['--data-dir', dataDir, 'serve', ...args], {
    cwd: root, env: baseEnv(root), detached: true, stdio: 'ignore',
  });
  daemons.push(daemon);
  const deadline = Date.now() + 15_000;
  while (!existsSync(socketPathFor(dataDir)) || !existsSync(join(dataDir, 'connection.json'))) {
    if (daemon.exitCode !== null) throw new Error(`relayflowd exited ${daemon.exitCode}`);
    if (Date.now() > deadline) throw new Error('relayflowd never published its connection');
    await new Promise(done => setTimeout(done, 50));
  }
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'flows-det-withhold-live-'));
  roots.push(root);
  symlinkSync(join(sdk, 'node_modules'), join(root, 'node_modules'));
  mkdirSync(join(root, 'bin'));
  const claude = join(root, 'bin', 'claude');
  writeFileSync(claude, `#!/usr/bin/env node
import { writeFileSync } from 'node:fs';
if (process.argv[2] === 'auth') process.exit(0);
if (process.argv.includes('Reply with exactly RELAYFLOWS_MODEL_READY and nothing else.')) {
  process.stdout.write('RELAYFLOWS_MODEL_READY\\n'); process.exit(0);
}
writeFileSync(${JSON.stringify(join(root, 'agent.env'))}, JSON.stringify(process.env));
process.stdout.write(${JSON.stringify(readFileSync(FIXTURE, 'utf8'))});
`);
  chmodSync(claude, 0o755);
  writeFileSync(join(root, 'flows.json'), JSON.stringify({ cli: claude, models: [MODEL] }));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'probe.flow.ts'), `import { flow } from '@relayflows/surface';
export default flow('probe', async f => {
  await f.run(${JSON.stringify(`env > '${join(root, 'det.env')}'`)});
  await f.agent('probe', { task: 'dump env', model: '${MODEL}' });
  f.done('success');
});
`);
  return root;
}

function lines(path: string): Map<string, string> {
  return new Map(readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as [string, string]));
}

it('a withheld agent key is absent from the det step and present in the agent step', async () => {
  const root = fixture();
  const dataDir = join(root, 'data');
  await startDaemon(root, dataDir, ['--det-withhold', Object.keys(AGENT).join(',')]);
  const result = spawnSync(process.execPath,
    [cli, 'run', '--json', '--data-dir', dataDir, '--local-agent', 'probe.flow.ts', '--input', '{}'],
    { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...baseEnv(root), ...AGENT, ...ORDINARY } });
  expect(result.status, result.stderr + result.stdout).toBe(0);
  const det = lines(join(root, 'det.env'));
  for (const [name, value] of Object.entries(AGENT)) {
    expect(det.has(name), `${name} reached the det step`).toBe(false);
    expect([...det.values()]).not.toContain(value);
  }
  expect(det.get('DELIVERED_SECRET')).toBe(ORDINARY['DELIVERED_SECRET']);
  const agent = JSON.parse(readFileSync(join(root, 'agent.env'), 'utf8')) as Record<string, string>;
  for (const [name, value] of Object.entries(AGENT)) expect(agent[name], `${name} lost by the agent`).toBe(value);
}, 120_000);
