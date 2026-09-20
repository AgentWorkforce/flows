import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { activateRecommendedFlow, getRecommendedFlow, listRecommendedFlows } from '../src/cloud-recommended.js';

interface Call { method: string; path: string; body: unknown }
function cloud(routes: Record<string, unknown | ((call: Call) => unknown)>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    const path = new URL(String(input)).pathname;
    const call = { method: init?.method ?? 'GET', path, body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const route = routes[path];
    if (route === undefined) return new Response('{"error":"not found"}', { status: 404 });
    const response = typeof route === 'function' ? route(call) : route;
    return new Response(JSON.stringify(response), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubEnv('FLOWS_CLOUD_URL', 'https://catalog.example');
  vi.stubEnv('FLOWS_CLOUD_TOKEN', 'catalog-token');
  return calls;
}

const SOFTWARE_GARDEN = {
  id: 'software-factory', version: 1, name: 'Software Garden', summary: 'Turns GitHub issues into reviewed pull requests.',
  description: 'A canonical GitHub Software Garden flow.', workflow: 'traditional',
  defaultLabel: 'Software Garden',
  supportedRepositoryHosts: ['github'], defaultTrigger: { provider: 'github', settings: {} },
  inputs: { required: ['approver'], defaults: { agents: ['claude'] }, allowedAgents: ['claude'] },
  source: {
    kind: 'github', owner: 'AgentWorkforce', repo: 'flows', path: 'examples/software-factory/software-factory.flow.ts',
    release: 'v2.0.22', ref: 'b4dd665eb433bd7f52d1045543aef5f14fb7891e',
    url: 'https://github.com/AgentWorkforce/flows/blob/b4dd665eb433bd7f52d1045543aef5f14fb7891e/examples/software-factory/software-factory.flow.ts',
    rawUrl: 'https://raw.githubusercontent.com/AgentWorkforce/flows/b4dd665eb433bd7f52d1045543aef5f14fb7891e/examples/software-factory/software-factory.flow.ts',
    mediaType: 'text/typescript', sha256: '41c2137179455881a0fcf568006d2b41e24386ba1cf7dc2c6051871b6f744368',
  },
};

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('recommended-flow catalog', () => {
  it('lists and reads the versioned catalog through the Cloud connection', async () => {
    const calls = cloud({
      '/api/v1/flows/catalog': { schemaVersion: 1, catalogVersion: 1, flows: [SOFTWARE_GARDEN] },
      '/api/v1/flows/catalog/software-factory': SOFTWARE_GARDEN,
    });
    await expect(listRecommendedFlows()).resolves.toEqual({ schemaVersion: 1, catalogVersion: 1, flows: [SOFTWARE_GARDEN] });
    await expect(getRecommendedFlow('software-factory')).resolves.toEqual(SOFTWARE_GARDEN);
    expect(calls.map(call => [call.method, call.path])).toEqual([
      ['GET', '/api/v1/flows/catalog'], ['GET', '/api/v1/flows/catalog/software-factory'],
    ]);
  });

  it('refuses malformed or mutable-source catalog data and invalid ids before treating it as usable', async () => {
    cloud({ '/api/v1/flows/catalog': { schemaVersion: 2, catalogVersion: 1, flows: [] } });
    await expect(listRecommendedFlows()).rejects.toMatchObject({ code: 'invalid_response' });
    cloud({ '/api/v1/flows/catalog': {
      schemaVersion: 1, catalogVersion: 1,
      flows: [{ ...SOFTWARE_GARDEN, source: { ...SOFTWARE_GARDEN.source, ref: 'main' } }],
    } });
    await expect(listRecommendedFlows()).rejects.toMatchObject({ code: 'invalid_response' });
    await expect(getRecommendedFlow('../software-factory')).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('recommended-flow activation', () => {
  it('resolves the workspace then posts one labeled multi-repository activation without copying source', async () => {
    const calls = cloud({
      '/api/v1/auth/whoami': { currentWorkspace: { id: 'ws-1' } },
      '/api/v1/flows/activations': {
        activationId: 'activation-1', flowId: 'software-factory', label: 'Platform garden', status: 'listening',
        repositories: [{ owner: 'acme', name: 'api' }, { owner: 'acme', name: 'web' }],
        listeners: [
          { agentId: 'agent-api', status: 'listening', repository: { owner: 'acme', name: 'api' } },
          { agentId: 'agent-web', status: 'listening', repository: { owner: 'acme', name: 'web' } },
        ],
      },
    });
    await expect(activateRecommendedFlow({
      flowId: 'software-factory', label: 'Platform garden', approver: 'khaliqgant',
      repositories: [{ owner: 'acme', name: 'api' }, { owner: 'acme', name: 'web' }],
    })).resolves.toMatchObject({ activationId: 'activation-1', status: 'listening' });
    expect(calls.map(call => [call.method, call.path])).toEqual([
      ['GET', '/api/v1/auth/whoami'], ['POST', '/api/v1/flows/activations'],
    ]);
    expect(calls[1]!.body).toEqual({
      workspaceId: 'ws-1', flowId: 'software-factory', label: 'Platform garden',
      repositories: [{ owner: 'acme', name: 'api' }, { owner: 'acme', name: 'web' }],
      inputs: { approver: 'khaliqgant' },
    });
  });

  it('parses list, show, and repeatable repository activation while preserving default agents', async () => {
    const calls = cloud({
      '/api/v1/flows/catalog': { schemaVersion: 1, catalogVersion: 1, flows: [SOFTWARE_GARDEN] },
      '/api/v1/flows/catalog/software-factory': SOFTWARE_GARDEN,
      '/api/v1/auth/whoami': { currentWorkspace: { id: 'ws-1' } },
      '/api/v1/flows/activations': {
        activationId: 'activation-1', flowId: 'software-factory', label: 'Garden', status: 'listening',
        repositories: [{ owner: 'acme', name: 'api' }, { owner: 'acme', name: 'web' }], listeners: [],
      },
    });
    const output: string[] = [];
    expect(await runCli(['recommended', 'list'], { stdout: line => output.push(line), stderr: line => output.push(`ERR ${line}`) })).toBe(0);
    expect(await runCli(['recommended', 'show', 'software-factory'], { stdout: line => output.push(line), stderr: line => output.push(`ERR ${line}`) })).toBe(0);
    expect(await runCli(['recommended', 'activate', 'software-factory', '--label', 'Garden', '--repository', 'acme/api',
      '--repository', 'acme/web', '--approver', 'khaliqgant'], { stdout: line => output.push(line), stderr: line => output.push(`ERR ${line}`) })).toBe(0);
    expect(output).toContain('ACTIVATED activation-1 listening');
    expect((calls.at(-1)!.body as { inputs: unknown }).inputs).toEqual({ approver: 'khaliqgant' });
  });

  it('refuses missing required activation arguments and duplicate repositories before requests', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(await runCli(['recommended', 'activate', 'software-factory', '--label', 'Garden', '--repository', 'acme/api'],
      { stdout: () => {}, stderr: () => {} })).toBe(2);
    expect(await runCli(['recommended', 'activate', 'software-factory', '--label', 'Garden', '--repository', 'acme/api',
      '--repository', 'acme/api', '--approver', 'k'], { stdout: () => {}, stderr: () => {} })).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});
