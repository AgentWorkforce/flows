import { afterEach, describe, expect, it, vi } from 'vitest';
import { CloudFlowError } from '../src/cloud-http.js';
import { MirrorClient, registerLocalRun } from '../src/cloud-mirror-transport.js';

type Seen = { url: string; method: string; authorization: string | null; body: string | undefined };

/** A Cloud stand-in at the fetch boundary, so the URL a credential reaches is observable. */
function server(response: (url: string) => { status: number; body: unknown }) {
  const seen: Seen[] = [];
  const fetchMock = vi.fn(async (url: string | URL, init: RequestInit = {}) => {
    const target = String(url);
    const headers = init.headers as Record<string, string> | undefined;
    seen.push({
      url: target,
      method: init.method ?? 'GET',
      authorization: headers?.['authorization'] ?? null,
      body: typeof init.body === 'string' ? init.body : undefined,
    });
    const { status, body } = response(target);
    return {
      ok: status < 300,
      status,
      json: async () => body,
    } as unknown as Response;
  });
  vi.stubGlobal('fetch', fetchMock);
  return seen;
}

const REGISTERED = {
  runId: 'cloud-run',
  status: 'running',
  dispatchType: 'local',
  callbackToken: 'cb-token',
  accessToken: 'cld_at_run',
  refreshToken: 'cld_rt_run',
  runUrl: 'https://staging.example.com/cloud/dashboard/workflow/cloud-run/runner',
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registerLocalRun', () => {
  it('sends the exact source and takes the run-bound credential back', async () => {
    const seen = server(() => ({ status: 201, body: REGISTERED }));

    const registration = await registerLocalRun(
      { workflow: 'name: demo\n', fileType: 'yaml' },
      { token: 'cld_at_operator', apiUrl: 'https://staging.example.com/cloud' },
    );

    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({
      url: 'https://staging.example.com/cloud/api/v1/workflows/local-run',
      method: 'POST',
      // Registration is the operator's call; everything after it is the run's.
      authorization: 'Bearer cld_at_operator',
    });
    expect(JSON.parse(seen[0]!.body!)).toEqual({
      workflow: 'name: demo\n', fileType: 'yaml', relayflowVersion: 'v2',
    });
    expect(registration).toMatchObject({
      runId: 'cloud-run', token: 'cld_at_run', callbackToken: 'cb-token',
      apiUrl: 'https://staging.example.com/cloud',
    });
  });

  it('refuses a receipt with no usable credential rather than reporting nowhere', async () => {
    server(() => ({ status: 201, body: { ...REGISTERED, accessToken: '   ' } }));
    await expect(registerLocalRun(
      { workflow: 'name: demo\n', fileType: 'yaml' },
      { token: 'cld_at_operator', apiUrl: 'https://staging.example.com/cloud' },
    )).rejects.toBeInstanceOf(CloudFlowError);
  });
});

describe('MirrorClient', () => {
  /**
   * The deployment is pinned by the registration, not re-resolved per call.
   *
   * `cloudConnection` falls back to the production default once an explicit
   * token is supplied — and every call after registration supplies one — so
   * without the pin a CLI signed in to a staging deployment would send that
   * deployment's run token to `agentrelay.com`.
   */
  it('sends every later call to the deployment that issued the credential', async () => {
    const seen = server(() => ({ status: 200, body: { ok: true } }));
    const client = new MirrorClient({
      runId: 'cloud-run',
      token: 'cld_at_run',
      callbackToken: 'cb-token',
      runUrl: REGISTERED.runUrl,
      apiUrl: 'https://staging.example.com/cloud',
    });

    await client.publishEvent({ eventType: 'relayflow.step.started', stepName: 'write' });
    await client.publishSnapshot({ sequence: 1, capturedAt: '2026-09-24T00:00:00.000Z', steps: [] });
    await client.publishSteps([], 0);
    await client.putObject('write/agent.log', Buffer.from('{}\n'));
    await client.reportTerminal('completed', { status: 'completed' });

    expect(seen.map(call => call.url)).toEqual([
      'https://staging.example.com/cloud/api/v1/workflows/runs/cloud-run/events',
      'https://staging.example.com/cloud/api/v1/workflows/runs/cloud-run/steps/snapshot',
      'https://staging.example.com/cloud/api/v1/workflows/runs/cloud-run/steps',
      'https://staging.example.com/cloud/api/v1/workflows/runs/cloud-run/storage/write/agent.log',
      'https://staging.example.com/cloud/api/v1/workflows/callback',
    ]);
    expect(seen.every(call => call.authorization === 'Bearer cld_at_run')).toBe(true);
    expect(seen[3]!.method).toBe('PUT');
  });

  it('answers false instead of throwing when Cloud refuses a push', async () => {
    server(() => ({ status: 503, body: { error: 'unavailable' } }));
    const client = new MirrorClient({
      runId: 'cloud-run',
      token: 'cld_at_run',
      callbackToken: 'cb-token',
      runUrl: REGISTERED.runUrl,
      apiUrl: 'https://staging.example.com/cloud',
    });

    await expect(client.publishSnapshot({ sequence: 1, capturedAt: 'x', steps: [] })).resolves.toBe(false);
    await expect(client.publishSteps([], 0)).resolves.toBe(false);
    await expect(client.reportTerminal('failed', {})).resolves.toBe(false);
  });

  it('refuses a storage key that could escape the run prefix, without a request', async () => {
    const seen = server(() => ({ status: 200, body: { ok: true } }));
    const client = new MirrorClient({
      runId: 'cloud-run',
      token: 'cld_at_run',
      callbackToken: 'cb-token',
      runUrl: REGISTERED.runUrl,
      apiUrl: 'https://staging.example.com/cloud',
    });

    for (const key of ['../other/agent.log', '/runner.log', 'a/../../b.log', '']) {
      await expect(client.putObject(key, Buffer.from('x'))).resolves.toBe(false);
    }
    expect(seen).toHaveLength(0);
  });
});
