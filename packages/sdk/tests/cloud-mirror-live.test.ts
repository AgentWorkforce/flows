// The mirror against a real local run, end to end.
//
// Every other test here folds a hand-built journal or stubs the transport.
// This one runs the built CLI against the real kernel, on a real flow, and
// stands a local HTTPS server where Cloud would be — so what is asserted is
// the bytes a mirrored run actually puts on the wire, in the order it puts
// them, not a reconstruction of them.
//
// Local HTTPS only. No hosted run is claimed and nothing leaves this machine.

import { existsSync, readdirSync, readFileSync, statSync, symlinkSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readDetachedRecord } from '../src/cli/detached-record.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const BUILT_CLI = join(ROOT, 'packages', 'sdk', 'dist', 'cli.js');
const FLOW = join(ROOT, 'testdata', 'hello-deterministic.flow.yaml');
const TOOLCHAIN_TARGET = process.env['CARGO_TARGET_DIR']
  ?? join(process.env['RELAYFLOWS_TOOLCHAIN_HOME'] ?? join(homedir(), '.relayflows-toolchain'), 'target');

/** Same resolution `live-kernel.test.ts` uses: ops/cargo.sh builds outside the repo. */
function locateRelayflowd(): string {
  const direct = join(TOOLCHAIN_TARGET, 'debug', 'relayflowd');
  if (existsSync(direct)) return direct;
  const keyed = existsSync(TOOLCHAIN_TARGET)
    ? readdirSync(TOOLCHAIN_TARGET)
      .map(entry => join(TOOLCHAIN_TARGET, entry, 'debug', 'relayflowd'))
      .filter(candidate => existsSync(candidate))
      .sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)
    : [];
  return keyed[0] ?? join(ROOT, 'kernel', 'target', 'debug', 'relayflowd');
}

const RELAYFLOWD = resolve(process.env['RELAYFLOWD_BIN'] ?? locateRelayflowd());

interface Seen {
  method: string;
  url: string;
  authorization: string | undefined;
  body: unknown;
}

let work: string;
let server: Server;
let origin: string;
let seen: Seen[] = [];

/** One `flows run`, with the stub Cloud configured. */
function runCli(
  args: readonly string[],
  extraEnv: NodeJS.ProcessEnv = {},
): Promise<{ stdout: string; stderr: string; code: number }> {
  return new Promise((done, reject) => {
    const child = spawn(process.execPath, [BUILT_CLI, ...args], {
      cwd: work,
      env: {
        ...process.env,
        NODE_EXTRA_CA_CERTS: join(work, 'cert.pem'),
        FLOWS_CLOUD_URL: origin,
        FLOWS_CLOUD_TOKEN: 'operator-token',
        RELAYFLOWD_BIN: RELAYFLOWD,
        ...extraEnv,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => done({ stdout, stderr, code: code ?? 1 }));
  });
}

async function waitForDetachedFinish(recordPath: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    const record = readDetachedRecord(recordPath);
    if (record?.phase === 'finished') return;
    if (record?.phase === 'refused') throw new Error(`detached run refused: ${JSON.stringify(record)}`);
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`detached run did not finish: ${recordPath}`);
}

async function waitForSeen(predicate: (call: Seen) => boolean): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (seen.some(predicate)) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`expected Cloud request was not observed: ${JSON.stringify(seen)}`);
}

async function waitForProcessExit(pid: number): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    try { process.kill(pid, 0); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error(`detached process did not exit: ${pid}`);
}

beforeAll(async () => {
  expect(existsSync(RELAYFLOWD), `relayflowd at ${RELAYFLOWD} — build it with (cd kernel && ../ops/cargo.sh build)`).toBe(true);
  expect(existsSync(BUILT_CLI), `built CLI at ${BUILT_CLI} — build it with (cd packages/sdk && npm run build)`).toBe(true);

  work = await mkdtemp(join(tmpdir(), 'cloud-mirror-live-'));
  symlinkSync(join(ROOT, 'packages', 'sdk', 'node_modules'), join(work, 'node_modules'));
  await writeFile(join(work, 'package.json'), '{"type":"module"}');
  const config = join(work, 'openssl.cnf');
  await writeFile(config, '[req]\ndistinguished_name=dn\nx509_extensions=ext\n[dn]\n[ext]\n'
    + 'subjectAltName=IP:127.0.0.1\nbasicConstraints=critical,CA:TRUE\n');
  const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=cloud-mirror-live', '-config', config,
    '-keyout', join(work, 'key.pem'), '-out', join(work, 'cert.pem')], { cwd: work });
  expect(openssl.status, String(openssl.stderr)).toBe(0);

  server = createServer(
    { key: readFileSync(join(work, 'key.pem')), cert: readFileSync(join(work, 'cert.pem')) },
    async (request, response) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(chunk as Buffer);
      const raw = Buffer.concat(chunks).toString('utf8');
      let body: unknown;
      try { body = JSON.parse(raw); } catch { body = raw; }
      seen.push({
        method: request.method ?? '',
        url: request.url ?? '',
        authorization: request.headers.authorization,
        body,
      });
      response.writeHead(request.url === '/api/v1/workflows/local-run' ? 201 : 200,
        { 'content-type': 'application/json' });
      response.end(request.url === '/api/v1/workflows/local-run'
        ? JSON.stringify({
          runId: 'live-cloud-run', status: 'running', dispatchType: 'local',
          callbackToken: 'cb', accessToken: 'cld_at_run', refreshToken: 'cld_rt_run',
          runUrl: `${origin}/dashboard/workflow/live-cloud-run/runner`,
        })
        : JSON.stringify({ ok: true }));
    },
  );
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  origin = `https://127.0.0.1:${typeof address === 'object' && address !== null ? address.port : 0}`;
}, 60_000);

afterAll(async () => {
  server?.closeAllConnections();
  await new Promise<void>(done => server?.close(() => done()));
  if (work) await rm(work, { recursive: true, force: true });
});

describe('a local run on the Cloud dashboard', () => {
  it('registers, publishes its steps and its log, and reports terminal last', async () => {
    seen = [];
    const run = await runCli(['run', '--cloud-mirror', '--no-observer-link', '--data-dir', join(work, 'data'), FLOW]);
    expect(run.code).toBe(0);

    // Registration is the operator's call; everything after it is the run's.
    expect(seen[0]).toMatchObject({
      method: 'POST', url: '/api/v1/workflows/local-run', authorization: 'Bearer operator-token',
    });
    expect(run.stderr).toContain(`Dashboard: ${origin}/dashboard/workflow/live-cloud-run/runner`);
    const registration = seen[0]!.body as { workflow: string; fileType: string; relayflowVersion: string };
    expect(registration.fileType).toBe('yaml');
    expect(registration.relayflowVersion).toBe('v2');
    expect(registration.workflow).toContain('name: hello-deterministic');

    const reports = seen.slice(1);
    expect(reports.every(call => call.authorization === 'Bearer cld_at_run')).toBe(true);

    const snapshot = reports.find(call => call.url.endsWith('/steps/snapshot'))!;
    const live = snapshot.body as { steps: Array<{ stepName: string; state: string; journalRunId: string }> };
    expect(live.steps.map(step => [step.stepName, step.state]))
      .toEqual([['greet', 'done'], ['shout', 'done']]);
    expect(live.steps[0]!.journalRunId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);

    const final = reports.find(call => call.url === '/api/v1/workflows/runs/live-cloud-run/steps')!;
    const rows = (final.body as { steps: Array<{ stepName: string; status: string; completionReason: string }> }).steps;
    expect(rows.map(row => [row.stepName, row.status, row.completionReason]))
      .toEqual([['greet', 'completed', 'success'], ['shout', 'completed', 'success']]);

    const log = reports.find(call => call.url.endsWith('/storage/runner.log'))!;
    expect(String(log.body)).toContain('greet');

    // Cloud revokes the run credential at the terminal transition, so every
    // write has to be in before it.
    const terminal = reports.at(-1)!;
    expect(terminal.url).toBe('/api/v1/workflows/callback');
    expect(terminal.body).toMatchObject({ status: 'completed', callbackToken: 'cb' });
  }, 120_000);

  it('keeps signed-in runs local unless the invocation explicitly opts in', async () => {
    seen = [];
    const plain = await runCli(['run', '--no-observer-link', '--data-dir', join(work, 'data'), FLOW]);
    const zero = await runCli(['run', '--no-observer-link', '--data-dir', join(work, 'data'), FLOW],
      { FLOWS_CLOUD_MIRROR: '0' });

    expect(plain.code, plain.stderr).toBe(0);
    expect(zero.code, zero.stderr).toBe(0);
    expect(plain.stderr).not.toContain('Dashboard:');
    expect(zero.stderr).not.toContain('Dashboard:');
    expect(seen).toEqual([]);

    seen = [];
    const signedOut = await runCli(['run', '--no-observer-link', '--data-dir', join(work, 'data'), FLOW],
      { FLOWS_CLOUD_TOKEN: undefined });
    expect(signedOut.code, signedOut.stderr).toBe(0);
    expect(signedOut.stderr).not.toContain('Dashboard:');
    expect(seen).toEqual([]);
  }, 180_000);

  it('keeps resume and detach local, while the environment switch remains an explicit opt-in', async () => {
    const dataDir = join(work, 'resume-data');
    seen = [];
    const initial = await runCli(['run', '--json', '--no-observer-link', '--data-dir', dataDir, FLOW]);
    expect(initial.code, initial.stderr).toBe(0);
    const runId = (JSON.parse(initial.stdout) as { runId: string }).runId;
    expect(runId).toMatch(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);
    expect(seen).toEqual([]);

    const resumed = await runCli(['resume', runId, '--json', '--no-observer-link', '--data-dir', dataDir]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(seen).toEqual([]);

    const detachedData = join(work, 'detached-data');
    const detached = await runCli(['run', '--json', '--no-observer-link', '--detach',
      '--data-dir', detachedData, FLOW]);
    expect(detached.code, detached.stderr).toBe(0);
    const handle = JSON.parse(detached.stdout) as { pid: number; recordPath: string };
    await waitForDetachedFinish(handle.recordPath);
    await waitForProcessExit(handle.pid);
    expect(seen).toEqual([]);

    const mirroredData = join(work, 'env-data');
    const mirrored = await runCli(['run', '--no-observer-link', '--data-dir', mirroredData, FLOW],
      { FLOWS_CLOUD_MIRROR: '1' });
    expect(mirrored.code, mirrored.stderr).toBe(0);
    expect(seen.some(call => call.url === '/api/v1/workflows/local-run')).toBe(true);
    expect(mirrored.stderr).toContain('Dashboard:');
  }, 180_000);

  it('mirrors resume and detached execution when the flag explicitly opts them in', async () => {
    const dataDir = join(work, 'explicit-resume-data');
    seen = [];
    const initial = await runCli(['run', '--json', '--no-observer-link', '--data-dir', dataDir, FLOW]);
    expect(initial.code, initial.stderr).toBe(0);
    const runId = (JSON.parse(initial.stdout) as { runId: string }).runId;
    expect(seen).toEqual([]);

    const resumed = await runCli(['resume', runId, '--cloud-mirror', '--no-observer-link',
      '--data-dir', dataDir]);
    expect(resumed.code, resumed.stderr).toBe(0);
    expect(resumed.stderr).toContain('Dashboard:');
    expect(seen.some(call => call.url === '/api/v1/workflows/local-run')).toBe(true);
    expect(seen.some(call => call.url === '/api/v1/workflows/callback')).toBe(true);

    seen = [];
    const detachedData = join(work, 'explicit-detached-data');
    const detached = await runCli(['run', '--json', '--no-observer-link', '--cloud-mirror', '--detach',
      '--data-dir', detachedData, FLOW]);
    expect(detached.code, detached.stderr).toBe(0);
    const handle = JSON.parse(detached.stdout) as { recordPath: string };
    await waitForDetachedFinish(handle.recordPath);
    await waitForSeen(call => call.url === '/api/v1/workflows/callback');
    expect(seen.some(call => call.url === '/api/v1/workflows/local-run')).toBe(true);
  }, 180_000);

  it('publishes a composed authored flow as one connected dashboard DAG', async () => {
    seen = [];
    await writeFile(join(work, 'child.flow.ts'), `import { flow } from '@relayflows/surface';
export default flow('child', async f => {
  await f.run("printf '%s' child");
  f.done('success');
});
`);
    const parent = join(work, 'parent.flow.ts');
    await writeFile(parent, `import { flow } from '@relayflows/surface';
export default flow('parent', { use: ['./child.flow.ts'] }, async f => {
  await f.run("printf '%s' before");
  await f.dispatch('child', {});
  await f.run("printf '%s' after");
  f.done('success');
});
`);
    const run = await runCli(['run', '--cloud-mirror', '--no-observer-link', '--data-dir',
      join(work, 'child-data'), parent, '--input', '{}']);
    expect(run.code, run.stderr).toBe(0);

    const final = seen.find(call => call.url === '/api/v1/workflows/runs/live-cloud-run/steps')!;
    const rows = (final.body as { steps: Array<{ stepName: string; label?: string; dependsOn?: string[] }> }).steps;
    expect(rows.map(row => row.stepName)).toEqual([
      'run-1', 'dispatch-2--run-1', 'dispatch-2', 'run-3',
    ]);
    expect(Object.fromEntries(rows.map(row => [row.stepName, {
      label: row.label, dependsOn: row.dependsOn,
    }]))).toEqual({
      'run-1': { label: undefined, dependsOn: [] },
      'dispatch-2--run-1': { label: undefined, dependsOn: ['run-1'] },
      'dispatch-2': { label: 'child', dependsOn: ['dispatch-2--run-1'] },
      'run-3': { label: undefined, dependsOn: ['dispatch-2'] },
    });
    expect(rows.some(row => /(?:^|--)complete-/.test(row.stepName))).toBe(false);

    const snapshot = seen.filter(call => call.url.endsWith('/steps/snapshot')).at(-1)!;
    const live = (snapshot.body as { steps: Array<{ stepName: string; dependsOn?: string[] }> }).steps;
    expect(live.map(step => step.stepName).sort()).toEqual(rows.map(row => row.stepName).sort());
  }, 120_000);
});
