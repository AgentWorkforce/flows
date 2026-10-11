import { execFileSync, spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { socketPathFor } from '../src/daemon-connection.js';

/**
 * Real SDK, real kernel, FAKE credentials only: the Cloud shape after #655
 * (docs/proposals/trusted-det-step-credentials.md §1).
 *
 * The host starts relayflowd itself with `daemonEnv` (the daemon-only token,
 * no agent keys) and runs `flows run --local-agent` with `cliEnv` (agent keys,
 * no token), exactly as cloud relayflow-v2-executor.ts does. A fake `claude`
 * (the adapter keys on the basename, so it gets the real adapter's env, not
 * the closed wrapper allowlist) and the `f.run` steps each dump their env.
 *
 * - "current main": NOT skipped. Reproduces D1 (det steps lose the token) and
 *   D2 (det steps receive agent keys) through the real SDK, while the actual
 *   agent step keeps its keys.
 * - "future contract": skipped unless FLOWS_DESIGN_FIXTURES=1. On main it
 *   fails at its first step because relayflowd rejects the binding flags: the
 *   interface is absent.
 */
const DESIGN = process.env['FLOWS_DESIGN_FIXTURES'] !== '1';
const sdk = resolve('.');
const cli = process.env['FLOWS_TEST_CLI'] ?? join(sdk, 'dist/cli.js');
const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'claude-stream-json-probe.jsonl');
const MODEL = 'claude-haiku-4-5-20251001';
const TOKEN = 'ghs_fixtureDaemonOnly_7Q2w9E4rT1xY';
const AGENT: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-fixtureAgentOnly-5Tz8Lm2Q',
  OPENAI_API_KEY: 'sk-fixtureAgentOnly-openai-3Kd1Vb7',
};
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

/** Only what the socket path and a shell need, never the test's own env. */
function baseEnv(home: string): Record<string, string> {
  const env: Record<string, string> = { PATH: process.env['PATH'] ?? '', HOME: home };
  for (const name of ['TMPDIR', 'XDG_RUNTIME_DIR']) if (process.env[name]) env[name] = process.env[name]!;
  return env;
}

/**
 * `body(dump)` is the flow body and `prelude(dump)` module top-level code,
 * which runs when the SDK imports the user module; `dump(name)` is an
 * absolute path under the root.
 */
function fixture(body: (dump: (name: string) => string) => string, prelude: (dump: (name: string) => string) => string = () => '') {
  const root = mkdtempSync(join(tmpdir(), 'flows-det-cred-live-'));
  const dump = (name: string) => join(root, name);
  roots.push(root);
  symlinkSync(join(sdk, 'node_modules'), join(root, 'node_modules'));
  mkdirSync(join(root, 'bin'));
  const claude = join(root, 'bin', 'claude');
  writeFileSync(claude, `#!/usr/bin/env node
import { readdirSync, readlinkSync, writeFileSync } from 'node:fs';
if (process.argv[2] === 'auth') process.exit(0);
if (process.argv.includes('Reply with exactly RELAYFLOWS_MODEL_READY and nothing else.')) {
  process.stdout.write('RELAYFLOWS_MODEL_READY\\n'); process.exit(0);
}
writeFileSync(${JSON.stringify(join(root, 'agent.env'))}, JSON.stringify(process.env));
const fds = {};
for (const fd of readdirSync('/proc/self/fd')) { try { fds[fd] = readlinkSync('/proc/self/fd/' + fd); } catch {} }
writeFileSync(${JSON.stringify(join(root, 'agent.fds'))}, JSON.stringify(fds));
process.stdout.write(${JSON.stringify(readFileSync(FIXTURE, 'utf8'))});
`);
  chmodSync(claude, 0o755);
  writeFileSync(join(root, 'flows.json'), JSON.stringify({ cli: claude, models: [MODEL] }));
  writeFileSync(join(root, 'package.json'), '{"type":"module"}');
  writeFileSync(join(root, 'probe.flow.ts'),
    `import { flow } from '@relayflows/surface';\n${prelude(dump)}\nexport default flow('probe', async f => {\n${body(dump)}\n  f.done('success');\n});\n`);
  const dataDir = join(root, 'data');
  return {
    root,
    dataDir,
    dump,
    /** The host's daemon spawn: daemonEnv, optional argv and stdin frame. */
    async startDaemon(args: string[], env: Record<string, string>, frame?: string): Promise<void> {
      const daemon = spawn(resolveDaemon(), ['--data-dir', dataDir, 'serve', ...args], {
        cwd: root, env: { ...baseEnv(root), ...env }, detached: true,
        stdio: ['pipe', 'ignore', 'pipe'],
      });
      daemons.push(daemon);
      let said = '';
      daemon.stderr!.on('data', chunk => { said += String(chunk); });
      daemon.stdin!.on('error', () => {});
      daemon.stdin!.end(frame ?? '');
      const exited = new Promise<number | null>(done => daemon.on('exit', code => done(code)));
      const deadline = Date.now() + 15_000;
      while (!existsSync(socketPathFor(dataDir)) || !existsSync(join(dataDir, 'connection.json'))) {
        const code = await Promise.race([exited, new Promise<'wait'>(done => setTimeout(() => done('wait'), 50))]);
        if (code !== 'wait') {
          throw new Error(`DESIGN FIXTURE: relayflowd exited (${code}) instead of serving with the `
            + `trusted det-step credential binding; the interface is absent. Daemon said: ${said}`);
        }
        if (Date.now() > deadline) throw new Error('relayflowd never published its connection');
      }
    },
    /**
     * The host's CLI spawn: cliEnv, plus an inherited fd 3 carrying K when
     * given. EVIDENCE LIMIT (proposal §14, J4): this is an unlinked seekable
     * FILE, not a pipe, so it cannot prove pipe-inode aliasing, EOF or
     * inheritance semantics; a real pipe-backed fixture is required once the
     * interface exists.
     */
    run(env: Record<string, string>, secret?: string) {
      const args = [cli, 'run', '--json', '--data-dir', dataDir, '--local-agent', 'probe.flow.ts', '--input', '{}'];
      if (secret === undefined) {
        return spawnSync(process.execPath, args, { cwd: root, encoding: 'utf8', timeout: 120_000, env: { ...baseEnv(root), ...env } });
      }
      writeFileSync(dump('k'), secret, { mode: 0o600 });
      const fd = openSync(dump('k'), 'r');
      unlinkSync(dump('k'));
      try {
        return spawnSync(process.execPath, args, {
          cwd: root, encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'pipe', fd],
          env: { ...baseEnv(root), ...env, FLOWS_CREDENTIAL_ROOT_PROOF_FD: '3' },
        });
      } finally {
        closeSync(fd);
      }
    },
  };
}

function lines(path: string): Map<string, string> {
  return new Map(readFileSync(path, 'utf8').split('\n').filter(Boolean)
    .map(line => [line.slice(0, line.indexOf('=')), line.slice(line.indexOf('=') + 1)] as [string, string]));
}

describe('current main (Cloud shape after #655)', () => {
  it('det steps lose the daemon-only token and receive agent keys; the agent step keeps its keys', async () => {
    const f = fixture(dump => `
  await f.run(${JSON.stringify(`env > '${dump('det.env')}'`)});
  await f.agent('probe', { task: 'dump env', model: '${MODEL}' });`);
    await f.startDaemon([], { GH_TOKEN: TOKEN });
    const result = f.run(AGENT);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const det = lines(f.dump('det.env'));
    expect(det.has('GH_TOKEN'), 'D1 not reproduced').toBe(false);
    for (const [name, value] of Object.entries(AGENT)) expect(det.get(name), `D2 not reproduced for ${name}`).toBe(value);
    const agent = JSON.parse(readFileSync(f.dump('agent.env'), 'utf8')) as Record<string, string>;
    for (const [name, value] of Object.entries(AGENT)) expect(agent[name]).toBe(value);
  }, 120_000);
});

describe('future contract (design fixture)', () => {
  it.skipIf(DESIGN)('declared det steps get the bound token, no det step gets agent keys, the agent keeps them', async () => {
    const f = fixture(dump => `
  await f.run(${JSON.stringify(`env > '${dump('declared.env')}'`)}, { credentials: ['GH_TOKEN'] });
  await f.run(${JSON.stringify(`env > '${dump('undeclared.env')}'`)});
  await f.agent('probe', { task: 'dump env', model: '${MODEL}' });`, dump => `
// Runs at user-module import time, inside the authored child: by now the SDK
// must have consumed and closed every K descriptor (proposal §4.3.2).
import { readdirSync as __fds, readlinkSync as __link, writeFileSync as __write } from 'node:fs';
const __seen = {};
for (const fd of __fds('/proc/self/fd')) { try { __seen[fd] = __link('/proc/self/fd/' + fd); } catch {} }
__write(${JSON.stringify(dump('authored.json'))}, JSON.stringify({ fds: __seen, env: process.env }));`);
    const secret = '5a1f0c9e7b3d2a4f6e8c1b0d9a7f5e3c2b4d6f8a0c1e3b5d7f9a2c4e6b8d0f1a';
    // The host derives a non-secret admission identity (Cloud: from the state
    // key) and reserves the matching kernel key (authored-root.ts:106,584-586).
    const identity = 'cloud-state-fixture-0001';
    const rootKey = `authored-root:${createHash('sha256').update(identity).digest('hex')}`;
    // argv only asks for the frame; the frame carries values, K, the root
    // authority pin and the withhold set (proposal §4.1). The pin comes from
    // the SDK's PROPOSED offline, non-executing `root-authority` command.
    const displayFields = ['/name', '/steps/0/instruction/flowName'];
    await f.startDaemon(['--det-frame-stdin'], {}, JSON.stringify({
      credentials: { GH_TOKEN: TOKEN },
      capability: secret,
      pins: {
        root_authority_sha256: execFileSync(process.execPath, [cli, 'root-authority', 'probe.flow.ts',
          '--input', '{}', '--admission-identity', identity, '--display-fields', displayFields.join(',')],
        { cwd: f.root, encoding: 'utf8' }).trim(),
        display_fields: displayFields,
        root_admission_key: rootKey,
      },
      withhold: Object.keys(AGENT),
    }) + '\n');
    const result = f.run({ ...AGENT, RELAYFLOW_AUTHORED_ADMISSION_KEY: identity }, secret);
    expect(result.status, result.stderr + result.stdout).toBe(0);
    const declared = lines(f.dump('declared.env'));
    const undeclared = lines(f.dump('undeclared.env'));
    expect(declared.get('GH_TOKEN')).toBe(TOKEN);
    expect(undeclared.has('GH_TOKEN')).toBe(false);
    for (const [name, value] of Object.entries(AGENT)) {
      for (const det of [declared, undeclared]) {
        expect(det.has(name)).toBe(false);
        expect([...det.values()]).not.toContain(value);
      }
    }
    const agent = JSON.parse(readFileSync(f.dump('agent.env'), 'utf8')) as Record<string, string>;
    for (const [name, value] of Object.entries(AGENT)) expect(agent[name]).toBe(value);
    expect(agent['GH_TOKEN']).toBeUndefined();
    // K descriptor controls: the SDK consumed fd 3 before loading authored
    // code and never passes it on, so neither the agent nor any det step holds
    // K, the descriptor (or an alias of its pipe) or its env name.
    for (const env of [agent, Object.fromEntries(declared), Object.fromEntries(undeclared)]) {
      expect(env['FLOWS_CREDENTIAL_ROOT_PROOF_FD']).toBeUndefined();
      expect(Object.values(env)).not.toContain(secret);
    }
    const fds = JSON.parse(readFileSync(f.dump('agent.fds'), 'utf8')) as Record<string, string>;
    expect(Object.values(fds).filter(target => target.startsWith(f.dump('k')))).toEqual([]);
    // Control (a): at user-module import the authored child holds no K source
    // descriptor, no fd-name env and no K.
    const authored = JSON.parse(readFileSync(f.dump('authored.json'), 'utf8')) as
      { fds: Record<string, string>; env: Record<string, string> };
    expect(Object.values(authored.fds).filter(target => target.startsWith(f.dump('k')))).toEqual([]);
    expect(authored.env['FLOWS_CREDENTIAL_ROOT_PROOF_FD']).toBeUndefined();
    expect(Object.values(authored.env)).not.toContain(secret);
  }, 120_000);
});
