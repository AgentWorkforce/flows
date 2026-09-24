// The mirror against a real local run, end to end.
//
// Every other test here folds a hand-built journal or stubs the transport.
// This one runs the built CLI against the real kernel, on a real flow, and
// stands a local HTTPS server where Cloud would be — so what is asserted is
// the bytes a mirrored run actually puts on the wire, in the order it puts
// them, not a reconstruction of them.
//
// Local HTTPS only. No hosted run is claimed and nothing leaves this machine.

import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:https';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

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
function runCli(args: readonly string[], extraEnv: NodeJS.ProcessEnv = {}): Promise<{ stderr: string; code: number }> {
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
    let stderr = '';
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.stdout.resume();
    child.on('error', reject);
    child.on('close', code => done({ stderr, code: code ?? 1 }));
  });
}

beforeAll(async () => {
  expect(existsSync(RELAYFLOWD), `relayflowd at ${RELAYFLOWD} — build it with (cd kernel && ../ops/cargo.sh build)`).toBe(true);
  expect(existsSync(BUILT_CLI), `built CLI at ${BUILT_CLI} — build it with (cd packages/sdk && npm run build)`).toBe(true);

  work = await mkdtemp(join(tmpdir(), 'cloud-mirror-live-'));
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
    const run = await runCli(['run', '--no-observer-link', '--data-dir', join(work, 'data'), FLOW]);
    expect(run.code).toBe(0);
    expect(run.stderr).toContain(`Dashboard: ${origin}/dashboard/workflow/live-cloud-run/runner`);

    // Registration is the operator's call; everything after it is the run's.
    expect(seen[0]).toMatchObject({
      method: 'POST', url: '/api/v1/workflows/local-run', authorization: 'Bearer operator-token',
    });
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

  it('sends nothing at all under either opt-out', async () => {
    seen = [];
    const flagged = await runCli(['run', '--no-cloud-mirror', '--no-observer-link', '--data-dir', join(work, 'data'), FLOW]);
    const shell = await runCli(['run', '--no-observer-link', '--data-dir', join(work, 'data'), FLOW],
      { FLOWS_CLOUD_MIRROR: '0' });

    expect(flagged.code).toBe(0);
    expect(shell.code).toBe(0);
    expect(seen).toEqual([]);
    expect(flagged.stderr).not.toContain('Dashboard:');
    expect(shell.stderr).not.toContain('Dashboard:');
  }, 120_000);
});
