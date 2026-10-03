import { describe, expect, it, vi } from 'vitest';
import { createFlowToolHttpTransport } from '../src/flow-tool-http.js';
import { FlowToolClient } from '../src/flow-tool-client.js';
import { flowToolInputDigest, flowToolRunLinks } from '../src/flow-tool-wire.js';
import { entry } from './flow-tool-control-fixture.js';
import type { FlowToolRunV1 } from '../src/flow-tool-contract.js';

const receipt: FlowToolRunV1 = {
  api_version: 1, accepted: true, run_id: 'run_fixture', tool_name: entry.manifest.name,
  deployment_id: entry.deployment_id, manifest_digest: entry.manifest.digest, flow_digest: entry.manifest.flow.digest,
  input_digest: flowToolInputDigest({ pr: 42 }), state: 'accepted', sequence: 1, terminal: null, ...flowToolRunLinks('run_fixture'),
};
const event = { api_version: 1, run_id: receipt.run_id, flow_digest: receipt.flow_digest, sequence: 2, type: 'run.state_changed', state: 'running' };
function sse(body: string) { return new Response(body, { headers: { 'content-type': 'text/event-stream' } }); }
function transport(fetcher: typeof fetch) {
  return createFlowToolHttpTransport({ apiUrl: 'https://example.invalid/cloud', token: 'test-only-scoped-bearer', fetch: fetcher });
}
function frame(value = event) { return `id: ${value.sequence}\nevent: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`; }

describe('explicit authenticated Flow Tool HTTP transport (fetch fixtures)', () => {
  it('sends pinned canonical input, dedicated header identity and stable idempotency, never follows redirects', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify(receipt), { headers: { 'content-type': 'application/json; charset=utf-8' } }));
    expect(await new FlowToolClient(transport(fetcher)).invoke(entry, { pr: 42 }, { idempotencyKey: 'operation-1' })).toEqual(receipt);
    const [url, init] = fetcher.mock.calls[0]!;
    expect(url).toBe('https://example.invalid/cloud/api/v1/flow-tools/review_pr/invoke');
    expect(init?.redirect).toBe('error');
    expect(init?.headers).toMatchObject({ Authorization: 'Bearer test-only-scoped-bearer', 'Idempotency-Key': 'operation-1' });
    expect(String(init?.body)).not.toContain('bearer');
    expect(JSON.parse(String(init?.body))).toMatchObject({ flow: `review-pr@${receipt.flow_digest}`, manifest_digest: receipt.manifest_digest, input_digest: receipt.input_digest });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it.each([[400, 'invalid_contract'], [401, 'not_authorized'], [403, 'not_authorized'], [404, 'not_found'], [409, 'idempotency_conflict'], [422, 'invalid_contract'], [501, 'unsupported'], [503, 'unavailable']])('maps HTTP %s without echoing bodies or retrying', async (status, code) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response('secret-response-fixture', { status: Number(status) }));
    await expect(new FlowToolClient(transport(fetcher)).discover()).rejects.toMatchObject({ code });
    try { await new FlowToolClient(transport(fetcher)).discover(); } catch (error) { expect(String(error)).not.toContain('secret-response-fixture'); }
    expect(fetcher).toHaveBeenCalledTimes(2); // two explicit calls, zero implicit retries
  });

  it('treats disconnect as unknown outcome, never a cancellation or automatic retry', async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValue(new Error('secret-token-fixture'));
    await expect(new FlowToolClient(transport(fetcher)).invoke(entry, { pr: 42 }, { idempotencyKey: 'op' })).rejects.toThrow('admission or command outcome may be unknown');
    expect(fetcher).toHaveBeenCalledTimes(1);
    try { await new FlowToolClient(transport(fetcher)).discover(); } catch (error) { expect(String(error)).not.toContain('secret-token-fixture'); }
  });

  it.each([
    { apiUrl: 'http://example.invalid', token: 'scoped' },
    { apiUrl: 'https://example.invalid?token=secret', token: 'scoped' },
    { apiUrl: 'https://example.invalid', token: 'rk_live_secret' },
    { apiUrl: 'https://example.invalid', token: 'ot_live_secret' },
    { apiUrl: 'https://example.invalid', token: 'injected\r\nHeader: value' },
  ])('refuses unsafe endpoint/credential configuration %# without request', options => {
    const fetcher = vi.fn<typeof fetch>();
    expect(() => createFlowToolHttpTransport({ ...options, fetch: fetcher })).toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each(['https://attacker.invalid', '/api/v1/flow-runs/../secret', '/api/v1/flow-runs/run_1?token=secret'])('refuses unsafe path %s before fetch', async path => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(transport(fetcher).request({ method: 'GET', path })).rejects.toMatchObject({ code: 'invalid_contract' });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it.each([
    ['text/html', '{}'], ['application/json', '{malformed'], ['application/json', 'x'.repeat(262145)],
  ])('refuses invalid or oversized JSON response %#', async (contentType, body) => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(body, { headers: { 'content-type': contentType } }));
    await expect(new FlowToolClient(transport(fetcher)).discover()).rejects.toMatchObject({ code: 'invalid_contract' });
  });

  it('reconnects SSE using journal cursor; parses split UTF-8/CRLF frames and ignores heartbeat comments', async () => {
    const bytes = new TextEncoder().encode(`: heartbeat\r\n\r\n${frame().replaceAll('\n', '\r\n')}`);
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => new Response(new ReadableStream({
      start(controller) { for (const byte of bytes) controller.enqueue(new Uint8Array([byte])); controller.close(); },
    }), { headers: { 'content-type': 'text/event-stream' } }));
    const values = []; for await (const value of new FlowToolClient(transport(fetcher)).events(entry, receipt, 1)) values.push(value);
    expect(values).toEqual([event]);
    expect(fetcher.mock.calls[0]?.[1]?.headers).toMatchObject({ 'Last-Event-ID': '1' });
  });

  it.each([
    frame().replace('id: 2', 'id: 1'),
    frame().replace('id: 2', 'id: NaN'),
    frame().replace('event: run.state_changed', 'event: another'),
    frame().slice(0, -1),
    `id: 2\nevent: run.state_changed\ndata: ${'x'.repeat(65537)}\n\n`,
    frame() + frame(),
  ])('rejects mismatched, incomplete, oversized or repeated event frames %#', async body => {
    const fetcher = vi.fn<typeof fetch>().mockImplementation(async () => sse(body));
    const consume = async () => { for await (const _ of new FlowToolClient(transport(fetcher)).events(entry, receipt, 1)) { /* validate every event */ } };
    await expect(consume()).rejects.toMatchObject({ code: 'invalid_contract' });
  });
});
