import { describe, expect, it, vi } from 'vitest';

import {
  agentRelaySpawn,
  deriveAgentName,
  readAgentRelayEnv,
  AgentRelayTransportError,
} from '../src/agent-relay-transport.js';

describe('agent-relay-transport (#385)', () => {
  it('reads baseUrl + apiKey from env with sane defaults', () => {
    const resolved = readAgentRelayEnv({
      RELAY_API_KEY: 'rk_live_xyz',
      RELAY_BASE_URL: '',
    } as NodeJS.ProcessEnv);
    expect(resolved.baseUrl).toBe('https://cast.agentrelay.com');
    expect(resolved.apiKey).toBe('rk_live_xyz');
    expect(resolved.workspaceId).toBeUndefined();
  });

  it('refuses when RELAY_API_KEY is missing', () => {
    expect(() => readAgentRelayEnv({} as NodeJS.ProcessEnv)).toThrow(AgentRelayTransportError);
  });

  it('derives a stable, DM-safe agent name from run + step id', () => {
    const a = deriveAgentName('01M2ABC', 'agent-4');
    const b = deriveAgentName('01M2ABC', 'agent-4');
    expect(a).toBe(b);
    expect(a).toMatch(/^flow-[a-z0-9-]+$/);
    expect(a).toContain('agent-4');
  });

  it('POSTs to /api/v1/agents/spawn with bearer auth and returns a handle', async () => {
    const fetchMock = vi.fn(async (url: string | URL, init?: RequestInit) => {
      expect(String(url)).toBe('https://cast.agentrelay.com/api/v1/agents/spawn');
      expect(init?.method).toBe('POST');
      const headers = init?.headers as Record<string, string>;
      expect(headers['authorization']).toBe('Bearer rk_live_xyz');
      expect(headers['content-type']).toBe('application/json');
      const body = JSON.parse(String(init?.body));
      expect(body.name).toBe('flow-run-x-step-y');
      expect(body.cli).toBe('codex');
      expect(body.task).toBe('do the thing');
      expect(body.model).toBe('gpt-6-astra');
      expect(body.worker_cwd).toBe('/tmp/wt');
      return new Response(JSON.stringify({
        invocation: {
          invocationId: 'inv_1',
          actionName: 'spawn',
          status: 'pending',
          input: { name: 'flow-run-x-step-y' },
        },
      }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    const handle = await agentRelaySpawn(
      { name: 'flow-run-x-step-y', cli: 'codex', task: 'do the thing', model: 'gpt-6-astra', worker_cwd: '/tmp/wt' },
      { apiKey: 'rk_live_xyz', fetch: fetchMock as unknown as typeof fetch },
    );
    expect(handle.registeredName).toBe('flow-run-x-step-y');
    expect(handle.invocationId).toBe('inv_1');
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('propagates a non-2xx response body as AgentRelayTransportError', async () => {
    const fetchMock = vi.fn(async () => new Response('workspace exhausted', { status: 429 }));
    await expect(
      agentRelaySpawn(
        { name: 'a', cli: 'codex', task: 't' },
        { apiKey: 'rk_live_xyz', fetch: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toBeInstanceOf(AgentRelayTransportError);
  });

  it('wraps network errors', async () => {
    const fetchMock = vi.fn(async () => { throw new Error('ECONNREFUSED'); });
    await expect(
      agentRelaySpawn(
        { name: 'a', cli: 'codex', task: 't' },
        { apiKey: 'rk_live_xyz', fetch: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/ECONNREFUSED/);
  });

  it('refuses when invocationId is missing from the response', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ invocation: {} }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    await expect(
      agentRelaySpawn(
        { name: 'a', cli: 'codex', task: 't' },
        { apiKey: 'rk_live_xyz', fetch: fetchMock as unknown as typeof fetch },
      ),
    ).rejects.toThrow(/invocation.invocationId/);
  });
});
