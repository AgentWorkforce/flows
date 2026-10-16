import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { postCloudSignal, waitForCloudSignal } from '../src/cloud-signal.js';

const clock = vi.hoisted(() => ({
  now: 0,
  sleep: null as null | ((ms: number, signal?: AbortSignal) => Promise<void>),
}));
vi.mock('node:timers/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:timers/promises')>();
  return {
    ...actual,
    setTimeout: (ms: number, value?: unknown, options?: { signal?: AbortSignal }) =>
      clock.sleep ? clock.sleep(ms, options?.signal).then(() => value) : actual.setTimeout(ms, value, options),
  };
});

const options = { apiUrl: 'https://cloud.example', token: 'scoped-token' };
const path = '/api/v1/workflows/runs/run_1/signals/render_done';
afterEach(() => { clock.sleep = null; clock.now = 0; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('Cloud completion signals', () => {
  it('holds GET until a POST completes, with no interval or one-second polling', async () => {
    let release!: () => void;
    const written = new Promise<void>(resolve => { release = resolve; });
    let posted = false;
    const calls: Array<{ method: string; path: string; auth: string | null }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      const method = init?.method ?? 'GET';
      calls.push({ method, path: url.pathname, auth: new Headers(init?.headers).get('authorization') });
      if (method === 'POST') {
        expect(JSON.parse(String(init?.body))).toEqual({ payload: { complete: true } });
        posted = true;
        release();
        return Response.json({ accepted: true, duplicate: false }, { status: 201 });
      }
      expect(url.searchParams.get('waitMs')).toBe('25000');
      await written;
      return Response.json({ payload: { complete: true }, acceptedAt: 123 });
    });
    const start = performance.now();
    const waiter = waitForCloudSignal('run_1', 'render_done', options);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1);
    expect(posted).toBe(false);
    await postCloudSignal('run_1', 'render_done', { complete: true }, options);
    expect(await waiter).toEqual({ complete: true });
    expect(performance.now() - start).toBeLessThan(1000);
    expect(calls.map(call => call.method)).toEqual(['GET', 'POST']);
    expect(calls.every(call => call.path === path && call.auth === 'Bearer scoped-token')).toBe(true);
  });

  it('backs off a fast 204 before re-arming', async () => {
    let reads = 0;
    const started = performance.now();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      reads += 1;
      return reads === 1 ? new Response(null, { status: 204 }) : Response.json({ payload: 7, acceptedAt: 123 });
    });
    expect(await waitForCloudSignal('run_1', 'render_done', options)).toBe(7);
    expect(reads).toBe(2);
    expect(performance.now() - started).toBeGreaterThanOrEqual(200);
  });

  it('bounds instant 204 retries and lets abort interrupt the backoff', async () => {
    const controller = new AbortController();
    let reads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      reads += 1;
      if (reads > 8) throw new Error('instant-204 hot loop');
      return new Response(null, { status: 204 });
    });
    const abort = setTimeout(() => controller.abort(new Error('cancel wait')), 30);
    try {
      await expect(waitForCloudSignal('run_1', 'render_done', { ...options, signal: controller.signal }))
        .rejects.toThrow('cancel wait');
      expect(reads).toBeLessThanOrEqual(2);
    } finally {
      clearTimeout(abort);
    }
  });

  it('caps repeated fast 204 backoff at five seconds on a controlled clock', async () => {
    clock.sleep = async (ms, signal) => { signal?.throwIfAborted(); clock.now += ms; };
    vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
    const reads: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      reads.push(performance.now());
      return reads.length <= 7 ? new Response(null, { status: 204 })
        : Response.json({ payload: 7, acceptedAt: 123 });
    });
    const waiter = waitForCloudSignal('run_1', 'render_done', options);
    expect(await waiter).toBe(7);
    expect(reads).toHaveLength(8);
    expect(reads.slice(1).map((value, index) => value - reads[index]!))
      .toEqual([250, 500, 1_000, 2_000, 4_000, 5_000, 5_000]);
  });

  it('resets the fast-204 backoff after a held response', async () => {
    clock.sleep = async (ms, signal) => { signal?.throwIfAborted(); clock.now += ms; };
    vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
    const reads: number[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      reads.push(performance.now());
      if (reads.length === 3) {
        clock.now += 25_000;
      }
      return reads.length <= 4 ? new Response(null, { status: 204 })
        : Response.json({ payload: 7, acceptedAt: 123 });
    });
    const waiter = waitForCloudSignal('run_1', 'render_done', options);
    expect(await waiter).toBe(7);
    expect(reads).toHaveLength(5);
    expect(reads[1]! - reads[0]!).toBe(250);
    expect(reads[2]! - reads[1]!).toBe(500);
    expect(reads[3]! - reads[2]!).toBe(25_000);
    expect(reads[4]! - reads[3]!).toBe(250);
  });

  it('rethrows caller abort while reading the signal body', async () => {
    const controller = new AbortController();
    const reason = new Error('stop waiting');
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => ({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      }),
    } as Response));
    const waiting = waitForCloudSignal('run_1', 'render_done', { ...options, signal: controller.signal });
    const result = expect(waiting).rejects.toBe(reason);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    controller.abort(reason);
    await result;
  });

  it('treats the per-request deadline during body read as transient', async () => {
    const deadline = new AbortController();
    vi.spyOn(AbortSignal, 'timeout').mockReturnValue(deadline.signal);
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => ({
      ok: true, status: 200,
      json: () => new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
      }),
    } as Response));
    const waiting = waitForCloudSignal('run_1', 'render_done', options);
    const result = expect(waiting).rejects.toMatchObject({ code: 'transient_error' });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    deadline.abort(new DOMException('deadline', 'TimeoutError'));
    await result;
  });

  it('classifies a reset connection during fetch as transient', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }),
    );
    await expect(waitForCloudSignal('run_1', 'render_done', options))
      .rejects.toMatchObject({ code: 'transient_error' });
  });

  it('classifies a reset connection during body read as transient', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.reject(new TypeError('read failed', { cause: { code: 'ECONNRESET' } })),
    } as Response);
    await expect(waitForCloudSignal('run_1', 'render_done', options))
      .rejects.toMatchObject({ code: 'transient_error' });
  });

  it('reserves invalid_response for malformed JSON and signal shape', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('bad JSON')) } as Response)
      .mockResolvedValueOnce(Response.json({ payload: 1 }));
    await expect(waitForCloudSignal('run_1', 'render_done', options))
      .rejects.toMatchObject({ code: 'invalid_response' });
    await expect(waitForCloudSignal('run_1', 'render_done', options))
      .rejects.toMatchObject({ code: 'invalid_response' });
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('uses the hosted read token for GET only when no Cloud login is configured', async () => {
    vi.stubEnv('AGENT_RELAY_HOME', join(tmpdir(), `cloud-signal-${randomUUID()}`));
    vi.stubEnv('FLOWS_CLOUD_TOKEN', undefined);
    vi.stubEnv('RELAYFLOW_V2_SIGNAL_READ_TOKEN', 'hosted-read-secret');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ payload: 7, acceptedAt: 123 }));
    expect(await waitForCloudSignal('run_1', 'render_done', { apiUrl: 'https://cloud.example' })).toBe(7);
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer hosted-read-secret');
  });

  it('never uses the hosted read token for POST or exposes it in an auth refusal', async () => {
    vi.stubEnv('AGENT_RELAY_HOME', join(tmpdir(), `cloud-signal-${randomUUID()}`));
    vi.stubEnv('FLOWS_CLOUD_TOKEN', undefined);
    vi.stubEnv('RELAYFLOW_V2_SIGNAL_READ_TOKEN', 'hosted-read-secret');
    const logged = [vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {})];
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }));
    await expect(postCloudSignal('run_1', 'render_done', { complete: true }, { apiUrl: 'https://cloud.example' }))
      .rejects.toMatchObject({ code: 'configuration', reason: 'auth_missing' });
    expect(fetch).not.toHaveBeenCalled();
    let refusal: unknown;
    try {
      await waitForCloudSignal('run_1', 'render_done', { apiUrl: 'https://cloud.example' });
    } catch (error) { refusal = error; }
    expect(refusal).toMatchObject({ code: 'http_error', status: 403 });
    expect(String(refusal)).not.toContain('hosted-read-secret');
    expect(logged.flatMap(spy => spy.mock.calls).flat().join(' ')).not.toContain('hosted-read-secret');
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('prefers an existing FLOWS_CLOUD_TOKEN over the hosted read token', async () => {
    vi.stubEnv('FLOWS_CLOUD_TOKEN', 'operator-token');
    vi.stubEnv('RELAYFLOW_V2_SIGNAL_READ_TOKEN', 'hosted-read-secret');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ payload: 7, acceptedAt: 123 }));
    expect(await waitForCloudSignal('run_1', 'render_done', { apiUrl: 'https://cloud.example' })).toBe(7);
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer operator-token');
  });

  it('rejects malformed names and oversized payloads before an HTTP request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ accepted: true, duplicate: false }));
    await expect(postCloudSignal('run_1', 'bad/name', 1, options)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(postCloudSignal('run_1', 'render_done', undefined, options))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(postCloudSignal('run_1', 'render_done', 'x'.repeat(5000), options))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    ['function', () => 1],
    ['symbol', Symbol('hidden')],
    ['toJSON undefined', { toJSON: () => undefined }],
  ])('rejects a %s payload that disappears from the serialized envelope', async (_kind, payload) => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ accepted: true, duplicate: false }));
    await expect(postCloudSignal('run_1', 'render_done', payload, options))
      .rejects.toMatchObject({ code: 'invalid_input' });
    expect(fetch).not.toHaveBeenCalled();
  });
});
