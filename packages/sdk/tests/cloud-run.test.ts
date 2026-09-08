import { createServer, type Server } from 'node:http';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { runInCloud, getCloudFlowRun, waitForCloudFlowRun } from '../src/cloud-run.js';
import { cloudConnection } from '../src/cloud-http.js';
import { compileSpec, toKernelSpec } from '../src/compile.js';
import { specHash } from '../src/canonical.js';
import type { FlowSpec } from '../src/spec.js';

const flow: FlowSpec = {
  version: '0.1.0', name: 'cloud-proof',
  steps: [{ id: 'gate', type: 'deterministic', command: 'printf verified' }],
};
const servers: Server[] = [];
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function cloud(handler: (path: string, body: unknown, auth: string | undefined) => unknown, status = 200) {
  const server = createServer(async (req, res) => {
    const parts: Buffer[] = [];
    for await (const part of req) parts.push(Buffer.from(part));
    const body = Buffer.concat(parts).toString();
    const response = handler(req.url!, body ? JSON.parse(body) : undefined, req.headers.authorization);
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(response));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('missing address');
  return { apiUrl: `http://127.0.0.1:${address.port}`, token: 'test-scoped-cloud-token' };
}

describe('hosted v2 submission', () => {
  it('uses the actual Cloud route and v2 dialect, returning acceptance rather than completion', async () => {
    const requests: unknown[] = [];
    const options = await cloud((path, body, auth) => {
      requests.push({ path, body, auth });
      return { runId: 'run-1', status: 'pending' };
    });
    const receipt = await runInCloud(flow, options);
    expect(receipt).toMatchObject({ runId: 'run-1', status: 'pending', apiUrl: `${options.apiUrl}/api/v1/workflows/runs/run-1` });
    expect(receipt.specHash).toMatch(/^[a-f0-9]{64}$/u);
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: '/api/v1/workflows/run', auth: 'Bearer test-scoped-cloud-token',
      body: { relayflowVersion: 'v2', fileType: 'yaml' },
    });
    const body = (requests[0] as { body: { workflow: string } }).body;
    expect(JSON.parse(body.workflow).steps[0]).toMatchObject({ id: 'gate', type: 'deterministic', command: 'printf verified' });
  });

  it('refuses invalid specs and unsupported hosted TS before any HTTP request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const options = { token: 'test-token' };
    await expect(runInCloud({ ...flow, steps: [] }, options)).rejects.toThrow();
    await expect(runInCloud({ path: 'example.flow.ts' }, options)).rejects.toMatchObject({ code: 'unsupported_source' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('accepts compiled kernel JSON using the existing compiler conversion', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cloud-spec-'));
    dirs.push(dir);
    const path = join(dir, 'spec.json');
    const compiled = toKernelSpec(compileSpec(flow));
    await writeFile(path, JSON.stringify(compiled));
    const options = await cloud(() => ({ runId: 'compiled-run', status: 'pending' }));
    expect((await runInCloud({ path }, options)).specHash).toBe(specHash(compiled));
  });

  it('refuses unsafe origins and Relay keys without sending credentials', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    for (const apiUrl of ['http://remote.example', 'https://user:pass@example.com', 'https://example.com/%2Fother', 'https://example.com?token=x']) {
      await expect(runInCloud(flow, { apiUrl, token: 'test-token' })).rejects.toMatchObject({ code: 'configuration' });
    }
    for (const token of ['', 'rk_live_secret', 'ot_live_secret', ' rk_live_secret', 'ot_live_secret ', 'token\nheader']) {
      await expect(runInCloud(flow, { token })).rejects.toMatchObject({ code: 'configuration' });
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it('preserves the production /cloud base path and normalized credentials', async () => {
    vi.stubEnv('FLOWS_CLOUD_URL', undefined);
    expect(cloudConnection({ token: ' test-token ' })).toEqual({ baseUrl: 'https://agentrelay.com/cloud', token: 'test-token' });
    const paths: string[] = [];
    const options = await cloud(path => { paths.push(path); return { runId: 'path-run', status: 'pending' }; });
    const receipt = await runInCloud(flow, { ...options, apiUrl: `${options.apiUrl}/cloud/` });
    expect(paths).toEqual(['/cloud/api/v1/workflows/run']);
    expect(receipt.apiUrl).toBe(`${options.apiUrl}/cloud/api/v1/workflows/runs/path-run`);
  });

  it('does not retry failed submissions or echo response secrets', async () => {
    let calls = 0;
    const options = await cloud(() => { calls++; return { secret: 'never-print-this' }; }, 503);
    await expect(runInCloud(flow, options)).rejects.toMatchObject({ code: 'http_error', status: 503, message: 'Cloud request failed with HTTP 503.' });
    expect(calls).toBe(1);
  });

  it('bounds a stalled HTTP request without retrying submission', async () => {
    let calls = 0;
    const server = createServer(() => { calls++; });
    servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('missing address');
    await expect(runInCloud(flow, {
      apiUrl: `http://127.0.0.1:${address.port}`, token: 'test-token', requestTimeoutMs: 100,
    })).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(calls).toBe(1);
  });

  it.each([
    { status: 'pending' }, { runId: '../elsewhere', status: 'pending' },
    { runId: 'run-1', status: 'completed' },
  ])('refuses malformed acceptance %j', async (response) => {
    const options = await cloud(() => response);
    await expect(runInCloud(flow, options)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('hosted observation', () => {
  it('continues across hours of elapsed time and returns the server terminal status', async () => {
    let calls = 0;
    const now = vi.spyOn(Date, 'now');
    const options = await cloud(() => {
      calls++;
      now.mockReturnValue(calls * 3_600_000);
      return { runId: 'long-run', relayflowVersion: 'v2', status: calls < 3 ? 'running' : 'failed' };
    });
    expect(await waitForCloudFlowRun('long-run', { ...options, pollIntervalMs: 1 })).toEqual({ runId: 'long-run', status: 'failed' });
    expect(calls).toBe(3);
  });

  it('abort ends observation without submitting a cancellation', async () => {
    const controller = new AbortController();
    const paths: string[] = [];
    const options = await cloud((path) => {
      paths.push(path);
      controller.abort();
      return { runId: 'run-1', relayflowVersion: 'v2', status: 'running' };
    });
    await expect(waitForCloudFlowRun('run-1', { ...options, signal: controller.signal })).rejects.toThrow();
    expect(paths).toEqual(['/api/v1/workflows/runs/run-1']);
  });

  it.each([
    { runId: 'other', relayflowVersion: 'v2', status: 'completed' },
    { runId: 'run-1', relayflowVersion: 'v1', status: 'completed' },
    { runId: 'run-1', relayflowVersion: 'v2', status: 'unknown' },
    { runId: 'run-1', relayflowVersion: 'v2', status: ['running'] },
  ])('refuses mismatched or unknown run records %j', async (response) => {
    const options = await cloud(() => response);
    await expect(getCloudFlowRun('run-1', options)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});

describe('thin cloud CLI', () => {
  it('runs from a YAML file without a daemon or local CLI', async () => {
    const options = await cloud(() => ({ runId: 'cli-1', status: 'pending' }));
    vi.stubEnv('FLOWS_CLOUD_URL', options.apiUrl);
    vi.stubEnv('FLOWS_CLOUD_TOKEN', options.token);
    vi.stubEnv('PATH', '');
    const dir = await mkdtemp(join(tmpdir(), 'cloud-cli-'));
    dirs.push(dir);
    const path = join(dir, 'flow.yaml');
    await writeFile(path, JSON.stringify(flow));
    const output: string[] = [];
    const code = await runCli(['run', '--cloud', '--json', path], { stdout: line => output.push(line), stderr: line => output.push(line) });
    expect(code).toBe(0);
    expect(output).toHaveLength(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ ok: true, runId: 'cli-1', status: 'pending' });
  });

  it.each([
    ['check', '--cloud', 'flow.yaml'], ['run', '--cloud', '--no-spawn', 'flow.yaml'],
    ['run', '--cloud', '--cloud', 'flow.yaml'], ['run', '--cloud', '--input', '{}', 'flow.yaml'],
    ['run', '--cloud', '--data-dir', 'x', 'flow.yaml'],
  ])('refuses incompatible argv %j', async (...args) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(await runCli(args, { stdout: () => {}, stderr: () => {} })).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});
