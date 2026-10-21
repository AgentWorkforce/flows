import { AsyncLocalStorage } from 'node:async_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { holdSignalWait, SignalError, waitForSignal } from '../src/signals.js';

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

const options = { runId: 'run_1', apiUrl: 'https://cloud.example', token: 'scoped-token' };
const path = '/api/v1/workflows/runs/run_1/signals/render_done';
afterEach(() => { clock.sleep = null; clock.now = 0; vi.restoreAllMocks(); vi.unstubAllEnvs(); });

describe('@relayflows/surface/signals waitForSignal', () => {
  it('holds one GET with waitMs=25000 until the signal lands', async () => {
    let release!: () => void;
    const written = new Promise<void>(resolve => { release = resolve; });
    const calls: Array<{ method: string; path: string; auth: string | null; redirect?: string }> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
      const url = new URL(String(input));
      calls.push({ method: init?.method ?? 'GET', path: url.pathname,
        auth: new Headers(init?.headers).get('authorization'), redirect: init?.redirect });
      expect(url.searchParams.get('waitMs')).toBe('25000');
      await written;
      return Response.json({ payload: { complete: true }, acceptedAt: 123 });
    });
    const start = performance.now();
    const waiter = waitForSignal('render_done', options);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(calls).toHaveLength(1);
    release();
    expect(await waiter).toEqual({ complete: true });
    expect(performance.now() - start).toBeLessThan(1000);
    expect(calls).toEqual([{ method: 'GET', path, auth: 'Bearer scoped-token', redirect: 'error' }]);
  });

  it('defaults runId, token, and base URL from the hosted environment', async () => {
    vi.stubEnv('RELAYFLOW_V2_CLOUD_RUN_ID', 'cloud-run-uuid');
    vi.stubEnv('RELAYFLOW_RUN_ID', 'engine-run-id');
    vi.stubEnv('RELAYFLOW_V2_SIGNAL_READ_TOKEN', 'hosted-read-secret');
    vi.stubEnv('FLOWS_CLOUD_URL', 'https://staging.example/cloud/');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ payload: 'ok', acceptedAt: 1 }));
    expect(await waitForSignal('native_done')).toBe('ok');
    expect(String(fetch.mock.calls[0]![0]))
      .toBe('https://staging.example/cloud/api/v1/workflows/runs/cloud-run-uuid/signals/native_done?waitMs=25000');
    expect(new Headers(fetch.mock.calls[0]![1]?.headers).get('authorization')).toBe('Bearer hosted-read-secret');
  });

  it('falls back to https://agentrelay.com/cloud and lets explicit options win over the environment', async () => {
    vi.stubEnv('RELAYFLOW_V2_CLOUD_RUN_ID', 'env-run');
    vi.stubEnv('RELAYFLOW_V2_SIGNAL_READ_TOKEN', 'env-token');
    vi.stubEnv('FLOWS_CLOUD_URL', undefined);
    const fetch = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => Response.json({ payload: 1, acceptedAt: 1 }));
    await waitForSignal('native_done');
    expect(String(fetch.mock.calls[0]![0]))
      .toBe('https://agentrelay.com/cloud/api/v1/workflows/runs/env-run/signals/native_done?waitMs=25000');
    vi.stubEnv('FLOWS_CLOUD_URL', 'https://ignored.example');
    await waitForSignal('native_done', { runId: 'arg_run', token: 'arg-token', apiUrl: 'https://cloud.example', waitMs: 500 });
    expect(String(fetch.mock.calls[1]![0]))
      .toBe('https://cloud.example/api/v1/workflows/runs/arg_run/signals/native_done?waitMs=500');
    expect(new Headers(fetch.mock.calls[1]![1]?.headers).get('authorization')).toBe('Bearer arg-token');
  });

  it('refuses a missing run ID or token as configuration, before any request, without echoing a token', async () => {
    vi.stubEnv('RELAYFLOW_V2_CLOUD_RUN_ID', undefined);
    vi.stubEnv('RELAYFLOW_V2_SIGNAL_READ_TOKEN', undefined);
    vi.stubEnv('RELAYFLOW_RUN_ID', 'engine-run-id');
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ payload: 1, acceptedAt: 1 }));
    await expect(waitForSignal('native_done', { token: 't' }))
      .rejects.toMatchObject({ name: 'SignalError', code: 'configuration', reason: 'run_id_missing' });
    await expect(waitForSignal('native_done', { runId: 'run_1' }))
      .rejects.toMatchObject({ code: 'configuration', reason: 'auth_missing' });
    for (const token of ['  ', 'line\nbreak', 'rk_live_relay-workspace-key']) {
      const refusal = await waitForSignal('native_done', { runId: 'run_1', token }).catch((error: unknown) => error);
      expect(refusal).toMatchObject({ code: 'configuration', reason: 'auth_missing' });
      expect(String((refusal as Error).message)).not.toContain(token.trim() || '\u0000');
    }
    await expect(waitForSignal('native_done', { ...options, apiUrl: 'http://cloud.example' }))
      .rejects.toMatchObject({ code: 'configuration', reason: 'url_invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('rejects malformed names, run IDs, waitMs, and timeouts before an HTTP request', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ payload: 1, acceptedAt: 1 }));
    await expect(waitForSignal('bad/name', options)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(waitForSignal('x'.repeat(81), options)).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(waitForSignal('render_done', { ...options, runId: '../run' }))
      .rejects.toMatchObject({ code: 'invalid_response' });
    for (const waitMs of [-1, 25_001, 1.5, Number.NaN]) {
      await expect(waitForSignal('render_done', { ...options, waitMs })).rejects.toMatchObject({ code: 'invalid_input' });
    }
    await expect(waitForSignal('render_done', { ...options, requestTimeoutMs: 25_000 }))
      .rejects.toMatchObject({ code: 'invalid_input', message: 'Signal requestTimeoutMs must exceed 25 seconds.' });
    await expect(waitForSignal('render_done', { ...options, requestTimeoutMs: 2_147_483_648 }))
      .rejects.toMatchObject({ code: 'configuration', reason: 'timeout_invalid' });
    expect(fetch).not.toHaveBeenCalled();
  });

  it('backs off a fast 204 before re-arming', async () => {
    let reads = 0;
    const started = performance.now();
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      reads += 1;
      return reads === 1 ? new Response(null, { status: 204 }) : Response.json({ payload: 7, acceptedAt: 123 });
    });
    expect(await waitForSignal('render_done', options)).toBe(7);
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
      await expect(waitForSignal('render_done', { ...options, signal: controller.signal }))
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
    expect(await waitForSignal('render_done', options)).toBe(7);
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
    expect(await waitForSignal('render_done', options)).toBe(7);
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
    const waiting = waitForSignal('render_done', { ...options, signal: controller.signal });
    const result = expect(waiting).rejects.toBe(reason);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    controller.abort(reason);
    await result;
  });

  it('rethrows an already-aborted caller signal without a request', async () => {
    const reason = new Error('already gone');
    const fetch = vi.spyOn(globalThis, 'fetch');
    await expect(waitForSignal('render_done', { ...options, signal: AbortSignal.abort(reason) })).rejects.toBe(reason);
    expect(fetch).not.toHaveBeenCalled();
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
    const waiting = waitForSignal('render_done', options);
    const result = expect(waiting).rejects.toMatchObject({ code: 'transient_error' });
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledOnce());
    deadline.abort(new DOMException('deadline', 'TimeoutError'));
    await result;
  });

  // Node 22's undici rejects a (handled) promise of an answered 204's body
  // stream when that request's signal aborts later, and the authored
  // completion gate fails the run on it. A settled request's signal must
  // therefore never abort: not from its deadline, not from the caller.
  it('detaches each settled request from its deadline and the caller signal', async () => {
    const caller = new AbortController();
    const signals: AbortSignal[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      signals.push(init!.signal!);
      return signals.length === 1 ? new Response(null, { status: 204 })
        : Response.json({ payload: 'done', acceptedAt: 1 });
    });
    expect(await waitForSignal('render_done', {
      ...options, waitMs: 0, requestTimeoutMs: 5, signal: caller.signal,
    })).toBe('done');
    await new Promise(resolve => setTimeout(resolve, 30));
    caller.abort(new Error('caller gave up later'));
    expect(signals).toHaveLength(2);
    expect(signals.map(signal => signal.aborted)).toEqual([false, false]);
  });

  // The authored completion gate tracks promises by async context. Requests
  // run outside the caller's, so transport-internal promises (Node 22 leaves
  // one pending per 204) are never counted as the flow author's work.
  it('runs each held request outside the caller async context', async () => {
    const context = new AsyncLocalStorage<string>();
    const seen: Array<string | undefined> = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      seen.push(context.getStore());
      return seen.length <= 3 ? new Response(null, { status: 204 })
        : Response.json({ payload: 'done', acceptedAt: 1 });
    });
    clock.sleep = async () => undefined;
    const result = await context.run('authored-body', async () => {
      const payload = await waitForSignal('render_done', options);
      return { payload, store: context.getStore() };
    });
    expect(result).toEqual({ payload: 'done', store: 'authored-body' });
    expect(seen).toEqual([undefined, undefined, undefined, undefined]);
  });

  it('still aborts an in-flight request on its deadline or the caller signal', async () => {
    const hang = (_input: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal!.reason), { once: true });
    });
    vi.spyOn(globalThis, 'fetch').mockImplementation(hang);
    await expect(waitForSignal('render_done', { ...options, waitMs: 0, requestTimeoutMs: 5 }))
      .rejects.toMatchObject({ code: 'transient_error' });
    const caller = new AbortController();
    const reason = new Error('stop');
    const waiting = waitForSignal('render_done', { ...options, signal: caller.signal });
    const result = expect(waiting).rejects.toBe(reason);
    await vi.waitFor(() => expect(globalThis.fetch).toHaveBeenCalledTimes(2));
    caller.abort(reason);
    await result;
  });

  it('classifies a reset connection during fetch as transient', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(
      new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }),
    );
    await expect(waitForSignal('render_done', options)).rejects.toMatchObject({ code: 'transient_error' });
  });

  it('classifies a reset connection during body read as transient', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue({
      ok: true, status: 200,
      json: () => Promise.reject(new TypeError('read failed', { cause: { code: 'ECONNRESET' } })),
    } as Response);
    await expect(waitForSignal('render_done', options)).rejects.toMatchObject({ code: 'transient_error' });
  });

  it('classifies other fetch failures as transport_error and HTTP refusals as http_error', async () => {
    vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new TypeError('fetch failed', { cause: { code: 'CERT_HAS_EXPIRED' } }))
      .mockResolvedValueOnce(new Response('{"token":"leak"}', { status: 403 }));
    await expect(waitForSignal('render_done', options)).rejects.toMatchObject({ code: 'transport_error' });
    const refusal = await waitForSignal('render_done', options).catch((error: unknown) => error);
    expect(refusal).toBeInstanceOf(SignalError);
    expect(refusal).toMatchObject({ code: 'http_error', status: 403 });
    expect(String(refusal)).not.toContain('leak');
  });

  it('reserves invalid_response for malformed JSON and signal shape', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce({ ok: true, status: 200, json: () => Promise.reject(new SyntaxError('bad JSON')) } as Response)
      .mockResolvedValueOnce(Response.json({ payload: 1 }))
      .mockResolvedValueOnce(Response.json({ acceptedAt: 1 }))
      .mockResolvedValueOnce(Response.json([1]));
    for (let attempt = 0; attempt < 4; attempt += 1) {
      await expect(waitForSignal('render_done', options)).rejects.toMatchObject({ code: 'invalid_response' });
    }
    expect(fetch).toHaveBeenCalledTimes(4);
  });

  it('returns a null payload as a delivered signal', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(Response.json({ payload: null, acceptedAt: 1 }));
    expect(await waitForSignal('render_done', options)).toBeNull();
  });
});

describe('holdSignalWait shared engine', () => {
  it('re-resolves the connection per held request and maps errors through the caller factory', async () => {
    class Custom extends Error { constructor(readonly code: string, message: string, readonly status?: number) { super(message); } }
    let resolved = 0;
    vi.spyOn(globalThis, 'fetch')
      .mockImplementationOnce(async () => { clock.now += 25_000; return new Response(null, { status: 204 }); })
      .mockResolvedValueOnce(new Response(null, { status: 500 }));
    vi.spyOn(performance, 'now').mockImplementation(() => clock.now);
    const refusal = await holdSignalWait('run_1', 'render_done', {}, {
      connection: () => ({ baseUrl: 'https://cloud.example', token: `t${++resolved}` }),
      error: (code, message, status) => new Custom(code, message, status),
    }).catch((error: unknown) => error);
    expect(resolved).toBe(2);
    expect(refusal).toBeInstanceOf(Custom);
    expect(refusal).toMatchObject({ code: 'http_error', status: 500 });
  });
});
