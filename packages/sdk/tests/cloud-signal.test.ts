import { afterEach, describe, expect, it, vi } from 'vitest';
import { postCloudSignal, waitForCloudSignal } from '../src/cloud-signal.js';

const options = { apiUrl: 'https://cloud.example', token: 'scoped-token' };
const path = '/api/v1/workflows/runs/run_1/signals/render_done';
afterEach(() => { vi.restoreAllMocks(); });

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

  it('re-arms immediately after a held GET times out with 204', async () => {
    let reads = 0;
    vi.spyOn(globalThis, 'fetch').mockImplementation(async () => {
      reads += 1;
      return reads === 1 ? new Response(null, { status: 204 }) : Response.json({ payload: 7, acceptedAt: 123 });
    });
    expect(await waitForCloudSignal('run_1', 'render_done', options)).toBe(7);
    expect(reads).toBe(2);
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
});
