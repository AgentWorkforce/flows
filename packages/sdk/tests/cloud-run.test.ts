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
const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function cloud(handler: (path: string, body: unknown, auth: string | undefined) => unknown, status = 200) {
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    init?.signal?.throwIfAborted();
    const response = handler(new URL(String(input)).pathname,
      init?.body ? JSON.parse(String(init.body)) : undefined,
      new Headers(init?.headers).get('authorization') ?? undefined);
    return new Response(JSON.stringify(response), { status, headers: { 'content-type': 'application/json' } });
  });
  return { apiUrl: 'https://cloud-contract.example', token: 'test-scoped-cloud-token' };
}

describe('hosted v2 submission', () => {
  it('uses the Cloud API contract route and v2 dialect, returning acceptance rather than completion', async () => {
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
    for (const apiUrl of ['http://remote.example', 'http://127.0.0.1', 'http://localhost', 'http://[::1]', 'https://user:pass@example.com', 'https://example.com/%2Fother', 'https://example.com?token=x']) {
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
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation((_input, init) =>
      new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true })));
    await expect(runInCloud(flow, {
      token: 'test-token', requestTimeoutMs: 20,
    })).rejects.toMatchObject({ code: 'transient_error' });
    expect(fetch).toHaveBeenCalledTimes(1);
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
  it('polls running records until a validated terminal reason arrives', async () => {
    let calls = 0;
    const options = await cloud(() => {
      calls++;
      return { runId: 'long-run', relayflowVersion: 'v2', status: calls < 3 ? 'running' : 'failed', result: { completionReason: 'step_failed' } };
    });
    expect(await waitForCloudFlowRun('long-run', { ...options, pollIntervalMs: 1 })).toEqual({ runId: 'long-run', status: 'failed', completionReason: 'step_failed' });
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

describe('review regressions', () => {
  async function cliFile() {
    const dir = await mkdtemp(join(tmpdir(), 'cloud-review-'));
    dirs.push(dir);
    const path = join(dir, 'flow.yaml');
    await writeFile(path, JSON.stringify(flow));
    vi.stubEnv('FLOWS_CLOUD_TOKEN', 'test-token');
    vi.stubEnv('FLOWS_CLOUD_URL', 'https://cloud-contract.example');
    return path;
  }

  it.each([401, 403])('refuses HTTP %i credentials with exit 2 before admission', async (status) => {
    await cloud(() => ({}), status);
    const path = await cliFile();
    const output: string[] = [];
    expect(await runCli(['run', '--cloud', '--json', path], { stdout: s => output.push(s), stderr: s => output.push(s) })).toBe(2);
    expect(JSON.parse(output[0]!)).toMatchObject({ code: 'http_error' });
  });

  it.each(['missing', 'yaml', 'schema'])('refuses %s input with exit 2 before HTTP', async (kind) => {
    const path = await cliFile();
    if (kind === 'missing') await rm(path);
    else await writeFile(path, kind === 'yaml' ? '[bad: yaml' : '{"steps":[]}');
    const fetch = vi.spyOn(globalThis, 'fetch');
    const output: string[] = [];
    expect(await runCli(['run', '--cloud', '--json', path], { stdout: s => output.push(s), stderr: s => output.push(s) })).toBe(2);
    expect(JSON.parse(output[0]!)).toMatchObject({ code: 'invalid_input' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reports unknown admission when interrupted before the POST receipt', async () => {
    const path = await cliFile();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      process.emit('SIGINT');
      init!.signal!.throwIfAborted();
      throw new Error('unexpected');
    });
    const output: string[] = [];
    expect(await runCli(['run', '--cloud', '--json', path], { stdout: s => output.push(s), stderr: s => output.push(s) })).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ code: 'admission_unknown', message: expect.stringContaining('Do not resubmit blindly') });
    expect(JSON.parse(output[0]!)).not.toHaveProperty('runId');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('preserves admitted run ID when observation is interrupted', async () => {
    const path = await cliFile();
    await cloud((url) => {
      if (url.endsWith('/run')) return { runId: 'retained', status: 'pending' };
      process.emit('SIGTERM');
      return { runId: 'retained', status: 'running', relayflowVersion: 'v2' };
    });
    const output: string[] = [];
    expect(await runCli(['run', '--cloud', '--wait', '--json', path], { stdout: s => output.push(s), stderr: s => output.push(s) })).toBe(1);
    expect(JSON.parse(output[0]!)).toMatchObject({ code: 'observation_aborted', runId: 'retained' });
  });

  it('emits separate acceptance lines and validated completion reason', async () => {
    const path = await cliFile();
    await cloud(url => url.endsWith('/run') ? { runId: 'done', status: 'pending' }
      : { runId: 'done', relayflowVersion: 'v2', status: 'completed', result: { ok: true, status: 'completed', completionReason: 'success' } });
    const output: string[] = [];
    expect(await runCli(['run', '--cloud', '--wait', path], { stdout: s => output.push(s), stderr: s => output.push(s) })).toBe(0);
    expect(output).toEqual(['ACCEPTED done (pending)', 'https://cloud-contract.example/api/v1/workflows/runs/done', 'COMPLETED done completionReason: success']);
  });

  it.each([503, 429, 'timeout', 'reset', 'body-timeout'])('retries safe observation after %s', async (failure) => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      expect(init?.method).toBe('GET');
      if (++calls === 1) {
        if (failure === 'timeout') throw new DOMException('timeout', 'TimeoutError');
        if (failure === 'reset') throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
        if (failure === 'body-timeout') return new Response(new ReadableStream({ start(c) { c.error(new DOMException('timeout', 'TimeoutError')); } }));
        return new Response('{}', { status: failure });
      }
      return Response.json({ runId: 'retry', relayflowVersion: 'v2', status: 'completed', result: { ok: true, status: 'completed', completionReason: 'success' } });
    });
    expect(await waitForCloudFlowRun('retry', { token: 'test-token', pollIntervalMs: 1 })).toMatchObject({ status: 'completed', completionReason: 'success' });
    expect(calls).toBe(2);
  });

  it.each([401, 403, 'invalid', 'tls', 'redirect'])('does not retry permanent observation failure %s', async (failure) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      expect(init?.redirect).toBe('error');
      if (failure === 'tls') throw new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } });
      if (failure === 'redirect') throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') });
      return new Response('{}', { status: typeof failure === 'number' ? failure : 200 });
    });
    await expect(waitForCloudFlowRun('retry', { token: 'test-token', pollIntervalMs: 1 })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('allows abort during transient retry backoff without another GET', async () => {
    const controller = new AbortController();
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      setTimeout(() => controller.abort(), 5);
      return new Response('{}', { status: 503 });
    });
    await expect(waitForCloudFlowRun('retry', { token: 'test-token', signal: controller.signal, pollIntervalMs: 100 })).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each([
    { status: 'completed' },
    { status: 'failed', result: { completionReason: 'unknown' } },
    { status: 'completed', result: { completionReason: 'step_failed' } },
    { status: 'cancelled', result: { completionReason: 'success' } },
  ])('refuses terminal records without consistent protocol evidence %j', async (record) => {
    const options = await cloud(() => ({ runId: 'terminal', relayflowVersion: 'v2', ...record }));
    await expect(getCloudFlowRun('terminal', options)).rejects.toMatchObject({ code: 'invalid_response' });
  });
});
