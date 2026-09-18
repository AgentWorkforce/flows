import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import {
  runInCloud, getCloudFlowRun, waitForCloudFlowRun, type RunInCloudOptions,
} from '../src/cloud-run.js';
import { cloudConnection, type CloudFlowError } from '../src/cloud-http.js';
import { compileSpec, toKernelSpec } from '../src/compile.js';
import { canonicalize, specHash } from '../src/canonical.js';
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

  it('refuses invalid specs and unsupported source extensions before any HTTP request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const options = { token: 'test-token' };
    await expect(runInCloud({ ...flow, steps: [] }, options)).rejects.toThrow();
    await expect(runInCloud({ path: 'example.txt' }, options)).rejects.toMatchObject({ code: 'unsupported_source' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('submits exact authored UTF-8 bytes with source and pinned Surface authority', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cloud-authored-'));
    dirs.push(dir);
    await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
    const path = join(dir, 'flagship.flow.ts');
    const source = "import { flow } from '@relayflows/surface';\n"
      + "// exact UTF-8 boundary: 🛰️\n"
      + "export default flow('cloud-authored', async f => f.done('success'));\n";
    await writeFile(path, source);
    let request: { workflow: string; fileType: string; relayflowVersion: string;
      inputs: unknown;
      authoredAuthority: { sourceSha256: string; byteLength: number;
        surface: { packageName: string; version: string; packageSha256: string; runtimeSha256: string } } } | undefined;
    const options = await cloud((_url, body) => {
      request = body as typeof request;
      return { runId: 'authored-run', status: 'pending' };
    });

    const receipt = await runInCloud({ path }, { ...options, input: {} });
    const surfaceManifest = JSON.parse(await readFile(
      join(process.cwd(), 'node_modules/@relayflows/surface/package.json'), 'utf8',
    )) as { version: string };

    expect(request).toMatchObject({ workflow: source, fileType: 'ts', relayflowVersion: 'v2', inputs: {} });
    expect(request!.authoredAuthority).toMatchObject({
      sourceSha256: createHash('sha256').update(Buffer.from(source)).digest('hex'),
      byteLength: Buffer.byteLength(source),
      surface: { packageName: '@relayflows/surface', version: surfaceManifest.version },
    });
    expect(request!.authoredAuthority.surface.packageSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(request!.authoredAuthority.surface.runtimeSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(receipt).toMatchObject({ runId: 'authored-run', status: 'pending' });
    expect(receipt.specHash).toBe(createHash('sha256')
      .update(canonicalize({ authority: request!.authoredAuthority, input: {} }))
      .digest('hex'));
  });

  it.each([
    { label: 'object', input: { prompt: 'ship', count: 2 } },
    { label: 'primitive', input: 'ship' },
    { label: 'array', input: [null, 1, true] },
    { label: 'null', input: null },
  ] as const)('preserves authored Cloud input: $label', async ({ input }) => {
    const dir = await mkdtemp(join(tmpdir(), 'cloud-authored-input-'));
    dirs.push(dir);
    await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
    const path = join(dir, 'input.flow.ts');
    await writeFile(path, "import { flow } from '@relayflows/surface';\n"
      + "export default flow('input', async f => f.done('success'));\n");
    let request: Record<string, unknown> | undefined;
    const connection = await cloud((_url, body) => {
      request = body as Record<string, unknown>;
      return { runId: 'input-run', status: 'pending' };
    });

    const receipt = await runInCloud(
      { path },
      { ...connection, input },
    );

    expect(Object.prototype.hasOwnProperty.call(request, 'inputs')).toBe(true);
    expect(request!.inputs).toEqual(input);
    const authority = request!.authoredAuthority;
    expect(receipt.specHash).toBe(createHash('sha256').update(canonicalize({
      authority,
      input,
    })).digest('hex'));
  });

  it('refuses declarative input plus omitted or undefined authored input before HTTP', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(runInCloud(flow, { token: 'test', input: null })).rejects.toMatchObject({ code: 'invalid_input' });
    const dir = await mkdtemp(join(tmpdir(), 'cloud-authored-input-invalid-'));
    dirs.push(dir);
    await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
    const path = join(dir, 'input.flow.ts');
    await writeFile(path, "import { flow } from '@relayflows/surface';\n"
      + "export default flow('input', async f => f.done('success'));\n");
    await expect(runInCloud({ path }, { token: 'test' }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(runInCloud({ path }, { token: 'test', input: undefined } as RunInCloudOptions))
      .rejects.toMatchObject({ code: 'invalid_input' });
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
  it('polls launching and running records until a validated terminal reason arrives', async () => {
    let calls = 0;
    const options = await cloud(() => {
      calls++;
      const status = calls === 1 ? 'launching' : calls === 2 ? 'running' : 'failed';
      return { runId: 'long-run', relayflowVersion: 'v2', status, result: { completionReason: 'step_failed' } };
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
    // `--local-agent` describes a local wrapper process, so it says nothing
    // about a run Cloud executes: refused rather than silently dropped.
    ['run', '--cloud', '--local-agent', 'flow.yaml'],
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

  it.each([503, 429, 'timeout', 'reset', 'body-timeout', 'body-abort'])('retries safe observation after %s', async (failure) => {
    let calls = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      expect(init?.method).toBe('GET');
      if (++calls === 1) {
        if (failure === 'timeout') throw new DOMException('timeout', 'TimeoutError');
        if (failure === 'reset') throw new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } });
        if (failure === 'body-abort') return new Response(new ReadableStream({ start(c) {
          init!.signal!.addEventListener('abort', () => c.error(new DOMException('aborted body', 'AbortError')), { once: true });
        } }));
        if (failure === 'body-timeout') return new Response(new ReadableStream({ start(c) { c.error(new DOMException('timeout', 'TimeoutError')); } }));
        return new Response('{}', { status: failure });
      }
      return Response.json({ runId: 'retry', relayflowVersion: 'v2', status: 'completed', result: { ok: true, status: 'completed', completionReason: 'success' } });
    });
    expect(await waitForCloudFlowRun('retry', { token: 'test-token', pollIntervalMs: 1, requestTimeoutMs: 20 })).toMatchObject({ status: 'completed', completionReason: 'success' });
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

describe('authored submission refusals are named (flows#461)', () => {
  it('turns relayflow_v2_authored_authority_invalid into a version-naming unsupported_source', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cloud-authority-'));
    dirs.push(dir);
    await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
    const path = join(dir, 'pinned.flow.ts');
    await writeFile(path, "import { flow } from '@relayflows/surface';\nexport default flow('pinned', async f => f.done('success'));\n");
    const surface = JSON.parse(await readFile(join(process.cwd(), 'node_modules/@relayflows/surface/package.json'), 'utf8')) as { version: string };
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({
      error: 'relayflow_v2_authored_authority_invalid',
      expected: { packageName: '@relayflows/surface', version: '2.0.11', packageSha256: 'never-read' },
      received: { packageName: '@relayflows/surface', version: surface.version },
    }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const error = await runInCloud({ path }, { apiUrl: 'https://cloud-contract.example', token: 'test-scoped-cloud-token', input: {} })
      .then(() => undefined, (e: unknown) => e as CloudFlowError);
    expect(error).toMatchObject({ code: 'unsupported_source', status: 400 });
    expect(error!.message).toContain('runs @relayflows/surface 2.0.11');
    expect(error!.message).toContain(`authored against ${surface.version}`);
    expect(error!.message).toContain('flows deploy');
    expect(error!.refusal).toEqual({ code: 'relayflow_v2_authored_authority_invalid', error: 'relayflow_v2_authored_authority_invalid',
      expected: { packageName: '@relayflows/surface', version: '2.0.11' }, received: { packageName: '@relayflows/surface', version: surface.version } });
  });

  it('reads a bare { error: "<code>" } refusal from the run route', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cloud-refusal-'));
    dirs.push(dir);
    await writeFile(join(dir, 'flow.yaml'), JSON.stringify(flow));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(JSON.stringify({ error: 'relayflow_v2_repository_contract_required' }),
      { status: 400, headers: { 'content-type': 'application/json' } }));
    const error = await runInCloud({ path: join(dir, 'flow.yaml') }, { apiUrl: 'https://cloud-contract.example', token: 'test-scoped-cloud-token' })
      .then(() => undefined, (e: unknown) => e as CloudFlowError);
    expect(error).toMatchObject({ code: 'http_error', status: 400 });
    expect(error!.message).toBe('Cloud refused (relayflow_v2_repository_contract_required): relayflow_v2_repository_contract_required');
  });

  it('names an authored source that does not load instead of calling it a declarative spec', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cloud-unloadable-'));
    dirs.push(dir);
    // No node_modules symlink: @relayflows/surface is not resolvable from here.
    const path = join(dir, 'lonely.flow.ts');
    await writeFile(path, "import { flow } from '@relayflows/surface';\nexport default flow('lonely', async f => f.done('success'));\n");
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const error = await runInCloud({ path }, { apiUrl: 'https://cloud-contract.example', token: 'test-scoped-cloud-token', input: {} })
      .then(() => undefined, (e: unknown) => e as CloudFlowError);
    expect(error).toMatchObject({ code: 'unsupported_source' });
    expect(error!.message).toContain('not a loadable authored flow');
    expect(error!.message).not.toContain('declarative');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe('refusal bodies keep transport classification', () => {
  it('reports an abort during a refusal-body read as an abort, not http_error', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cloud-refusal-abort-'));
    dirs.push(dir);
    await writeFile(join(dir, 'flow.yaml'), JSON.stringify(flow));
    const controller = new AbortController();
    // A real fetch rejects the body read when its signal aborts; the mock does the same.
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response(new ReadableStream({
      start(stream) {
        controller.signal.addEventListener('abort', () => stream.error(new DOMException('The operation was aborted.', 'AbortError')));
      },
      pull() { controller.abort(); },
    }), { status: 400, headers: { 'content-type': 'application/json' } }));
    const error = await runInCloud({ path: join(dir, 'flow.yaml') },
      { apiUrl: 'https://cloud-contract.example', token: 'test-scoped-cloud-token', signal: controller.signal })
      .then(() => undefined, (e: unknown) => e as Error & { code?: string });
    expect(error?.name).toBe('AbortError');
    expect(error?.code).not.toBe('http_error');
  });

  it('treats a non-JSON refusal body as a bare HTTP failure', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cloud-refusal-html-'));
    dirs.push(dir);
    await writeFile(join(dir, 'flow.yaml'), JSON.stringify(flow));
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('<html>502</html>', { status: 502, headers: { 'content-type': 'text/html' } }));
    await expect(runInCloud({ path: join(dir, 'flow.yaml') }, { apiUrl: 'https://cloud-contract.example', token: 'test-scoped-cloud-token' }))
      .rejects.toMatchObject({ code: 'http_error', status: 502, message: 'Cloud request failed with HTTP 502.' });
  });
});
