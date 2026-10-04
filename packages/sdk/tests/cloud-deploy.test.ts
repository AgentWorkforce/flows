import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { deployToCloud, parseAgentHarnesses, parseRepository, parseTriggerSource } from '../src/cloud-deploy.js';
import { cloudConnection } from '../src/cloud-http.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

interface Call { method: string; path: string; auth: string | undefined; body: unknown }
function cloud(routes: Record<string, (call: Call) => { status?: number; body: unknown } | unknown>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    init?.signal?.throwIfAborted();
    const path = new URL(String(input)).pathname;
    const call: Call = { method: init?.method ?? 'GET', path,
      auth: new Headers(init?.headers).get('authorization') ?? undefined,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const route = routes[path];
    // Unless a test says otherwise, every integration the workspace is asked about is connected.
    if (!route && /\/integrations\/[^/]+\/status$/u.test(path)) {
      return new Response(JSON.stringify({ ready: true, state: 'ready' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (!route) return new Response('{"error":"not found"}', { status: 404 });
    const answer = route(call);
    const { status, body } = answer !== null && typeof answer === 'object' && 'status' in answer && 'body' in answer
      ? answer as { status?: number; body: unknown } : { status: 200, body: answer };
    return new Response(JSON.stringify(body), { status: status ?? 200, headers: { 'content-type': 'application/json' } });
  });
  vi.stubEnv('FLOWS_CLOUD_URL', 'https://cloud-contract.example');
  vi.stubEnv('FLOWS_CLOUD_TOKEN', 'test-cli-auth-token');
  return calls;
}

const WHOAMI = { authenticated: true, currentWorkspace: { id: 'ws-1', slug: 'default' } };

async function authoredFlow(name = 'issue-triage'): Promise<string> {
  const dir = await tempDir('cloud-deploy-');
  await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
  const path = join(dir, `${name}.flow.ts`);
  await writeFile(path, "import { flow } from '@relayflows/surface';\n"
    + `export default flow<{ issue: { title: string }; approver: string }>('${name}', { budget: '$5/run' }, async (f, input) => {\n`
    + "  await f.run(`echo ${JSON.stringify(input.issue.title)}`);\n  f.done('success');\n});\n");
  return path;
}

describe('trigger source and repository parsing', () => {
  it.each([
    ['github', { provider: 'github', settings: {} }],
    ['github:labels=agent,contains=urgent', { provider: 'github', settings: { labels: 'agent', contains: 'urgent' } }],
    ['slack:channel=#eng', { provider: 'slack', settings: { channel: '#eng' } }],
    ['linear:team=ENG', { provider: 'linear', settings: { team: 'ENG' } }],
    ['linear:team=Engineering,labels=agent,contains=urgent', { provider: 'linear', settings: { team: 'Engineering', labels: 'agent', contains: 'urgent' } }],
    ['linear:events=assigned', { provider: 'linear', settings: { events: 'assigned' } }],
    ['linear:events=ALL,team=TECH', { provider: 'linear', settings: { events: 'all', team: 'TECH' } }],
    ['jira:project=OPS,labels=agent', { provider: 'jira', settings: { project: 'OPS', labels: 'agent' } }],
    ['shortcut:workspace=acme,team=Platform', { provider: 'shortcut', settings: { workspace: 'acme', team: 'Platform' } }],
    ['gitlab:project=acme/platform/web', { provider: 'gitlab', settings: { project: 'acme/platform/web' } }],
    ['gitlab:events=merge_request,labels=agent', { provider: 'gitlab', settings: { events: 'merge_request', labels: 'agent' } }],
    ['github:events=pull_request,labels=agent', { provider: 'github', settings: { events: 'pull_request', labels: 'agent' } }],
    ['github:events=PULL_REQUEST', { provider: 'github', settings: { events: 'pull_request' } }],
    ['github:events=pull_request,reviews=False', { provider: 'github', settings: { events: 'pull_request', reviews: 'false' } }],
  ])('parses %s', (value, expected) => {
    expect(parseTriggerSource(value)).toEqual(expected);
  });

  it.each(['github:channel=x', 'github:labels=', 'github:labels=a,labels=b', 'slack:labels=x', 'github:events=releases', 'gitlab:events=pull_request', 'gitlab:repository=acme/web', 'github:reviews=maybe', 'linear:events=mentions', 'linear:events=pull_request'])
  ('refuses %s', (value) => {
    expect(() => parseTriggerSource(value)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });

  it.each([
    ['AgentWorkforce/flows', { owner: 'AgentWorkforce', name: 'flows' }],
    ['https://github.com/AgentWorkforce/flows.git', { owner: 'AgentWorkforce', name: 'flows' }],
    ['github:owner/name', { owner: 'owner', name: 'name' }],
    ['http://github.com/o/r', { owner: 'o', name: 'r' }],
    ['gitlab/myrepo', { owner: 'gitlab', name: 'myrepo' }],
    ['github/docs', { owner: 'github', name: 'docs' }],
    ['gitlab:group/project', { owner: 'group', name: 'project', host: 'gitlab' }],
    ['gitlab:group/sub/project', { owner: 'group/sub', name: 'project', host: 'gitlab' }],
    ['https://gitlab.com/group/sub/project.git', { owner: 'group/sub', name: 'project', host: 'gitlab' }],
    ['http://GITLAB.com/g/p', { owner: 'g', name: 'p', host: 'gitlab' }],
    ['GITLAB:g/p', { owner: 'g', name: 'p', host: 'gitlab' }],
    ['gitlab:https://gitlab.com/g/p', { owner: 'g', name: 'p', host: 'gitlab' }],
  ])('parses repository %s', (value, expected) => {
    expect(parseRepository(value)).toStrictEqual(expected);
  });

  it.each(['flows', 'a/b/c', 'bad owner/x', '', 'gitlab:project', 'gitlab:',
    'gitlab:a//b', 'gitlab:bad segment/p', 'gitlab:.leading/p', 'gitlab:-leading/p',
    `gitlab:${'g'.repeat(101)}/p`,
    'https://gitlab.com/group', 'gitlab:https://github.com/o/r', 'github:https://gitlab.com/g/p',
    'https://gitlab.example.com/g/p', 'git@gitlab.com:g/p.git', 'gitlab:g/p/',
  ])('refuses repository %s', (value) => {
    expect(() => parseRepository(value)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });

  // Cloud's isValidFlowRepositoryCoordinates (AgentWorkforce/cloud
  // packages/web/lib/flows/flow-repository.ts), pinned at each boundary.
  describe('GitLab coordinates match Cloud', () => {
    const owner = (segments: number) => Array(segments).fill('g').join('/');
    // 100 + 1 + 100 + 1 + 53 = 255 characters.
    const longOwner = (length: number) => `${'a'.repeat(100)}/${'b'.repeat(100)}/${'c'.repeat(length - 202)}`;

    it.each([
      ['20 owner segments', `gitlab:${owner(20)}/p`, owner(20), 'p'],
      ['a 255-character owner', `gitlab:${longOwner(255)}/p`, longOwner(255), 'p'],
      ['100-character segments', `gitlab:${'g'.repeat(100)}/${'p'.repeat(100)}`, 'g'.repeat(100), 'p'.repeat(100)],
      ['a digit-led segment', 'gitlab:9g/0p', '9g', '0p'],
      ['inner dots, dashes and underscores', 'gitlab:g.x-y_z/p.atomic', 'g.x-y_z', 'p.atomic'],
      ['a stripped .git URL suffix', 'gitlab:g/p.git', 'g', 'p'],
    ])('accepts %s', (_case, value, expectedOwner, expectedName) => {
      expect(parseRepository(value)).toStrictEqual({ owner: expectedOwner, name: expectedName, host: 'gitlab' });
    });

    it.each([
      ['21 owner segments', `gitlab:${owner(21)}/p`],
      ['a 256-character owner', `gitlab:${longOwner(256)}/p`],
      ['a 101-character name', `gitlab:g/${'p'.repeat(101)}`],
      ['an underscore-led owner segment', 'gitlab:_g/p'],
      ['an underscore-led name', 'gitlab:g/_p'],
      ['a dot-led name', 'gitlab:g/.p'],
      ['a dash-led name', 'gitlab:g/-p'],
      ['an owner segment ending in .', 'gitlab:g./p'],
      ['an owner segment ending in .git', 'gitlab:g/s.git/p'],
      ['an owner segment ending in .atom', 'gitlab:g.atom/p'],
      ['a name ending in .', 'gitlab:g/p.'],
      ['a name ending in .git', 'gitlab:g/p.git.git'],
      ['a name ending in .atom', 'gitlab:g/p.atom'],
    ])('refuses %s', (_case, value) => {
      expect(() => parseRepository(value)).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    });
  });

  it('omits the host key for GitHub', () => {
    expect('host' in parseRepository('owner/name')).toBe(false);
  });
});

describe('deployToCloud', () => {
  it('resolves the workspace, then posts the exact source with defaulted GitHub scope and the flow name', async () => {
    const path = await authoredFlow();
    const calls = cloud({
      '/api/v1/auth/whoami': () => WHOAMI,
      '/api/v1/flows/deploy': () => ({ status: 201, body: { agentId: 'agent-1', status: 'listening', sources: [], repository: {} } }),
    });
    const deployment = await deployToCloud({
      path, repository: { owner: 'AgentWorkforce', name: 'flows' },
      sources: [parseTriggerSource('github:labels=agent'), parseTriggerSource('slack:channel=C123')],
      approver: 'khaliqgant',
    });
    // The workspace first, then each required integration's status (the
    // deploy target's GitHub and the Slack source), then the deploy itself.
    expect(calls.map(c => [c.method, c.path])).toEqual([
      ['GET', '/api/v1/auth/whoami'],
      ['GET', '/api/v1/workspaces/ws-1/integrations/github/status'],
      ['GET', '/api/v1/workspaces/ws-1/integrations/slack/status'],
      ['POST', '/api/v1/flows/deploy'],
    ]);
    expect(new URL(String(vi.mocked(fetch).mock.calls[1]![0])).searchParams.get('scope')).toBe('workspace');
    const body = calls[3]!.body as Record<string, unknown>;
    // The serialized body carries Cloud's lowercase enum whatever the shell typed.
    expect(parseTriggerSource('github:events=Pull_Request').settings.events).toBe('pull_request');
    expect(body).toMatchObject({
      workspaceId: 'ws-1', mode: 'activate', name: 'issue-triage', workflow: 'flows-cli',
      inputs: { approver: 'khaliqgant', agents: ['claude'] }, repository: { owner: 'AgentWorkforce', name: 'flows' },
      sources: [
        { provider: 'github', settings: { labels: 'agent', repository: 'AgentWorkforce/flows' } },
        { provider: 'slack', settings: { channel: 'C123' } },
      ],
      requirements: { integrations: ['github', 'slack'], harnesses: [], mcp: [] },
    });
    expect(body.repository).toStrictEqual({ owner: 'AgentWorkforce', name: 'flows' });
    expect(body.handoffId).toMatch(/^flows-cli-[a-f0-9]{16}$/u);
    expect(body.source).toContain("flow<{ issue: { title: string }; approver: string }>('issue-triage'");
    expect(body.extensions).toBeUndefined();
    expect(deployment).toMatchObject({ agentId: 'agent-1', status: 'listening', name: 'issue-triage', connected: [] });
    expect(deployment.requirements.integrations.map(i => `${i.provider} (${i.detail})`)).toEqual(['github (--on github)', 'slack (--on slack)']);
    expect(deployment.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
  });

  it.each([
    ['gitlab:labels=x', ['gitlab (--on gitlab)']],
    ['linear:team=ENG', ['linear (--on linear)', 'gitlab (deploy target)']],
  ])('requires the GitLab target integration with %s', async (trigger, details) => {
    const path = await authoredFlow();
    const calls = cloud({
      '/api/v1/auth/whoami': () => WHOAMI,
      '/api/v1/flows/deploy': () => ({ status: 201, body: { agentId: 'a', status: 'listening' } }),
    });
    const repository = parseRepository('gitlab:group/sub/web');
    const deployment = await deployToCloud({ path, repository, sources: [parseTriggerSource(trigger)], approver: 'k' });
    const body = calls.at(-1)!.body as Record<string, unknown>;
    expect(body.repository).toStrictEqual({ owner: 'group/sub', name: 'web', host: 'gitlab' });
    const providers = trigger.startsWith('gitlab') ? ['gitlab'] : ['linear', 'gitlab'];
    expect(body.requirements).toStrictEqual({ integrations: providers, harnesses: [], mcp: [] });
    expect(calls.map(c => c.path)).toEqual([
      '/api/v1/auth/whoami', ...providers.map(p => `/api/v1/workspaces/ws-1/integrations/${p}/status`), '/api/v1/flows/deploy',
    ]);
    expect(deployment.requirements.integrations.map(i => `${i.provider} (${i.detail})`)).toEqual(details);
    if (trigger.startsWith('gitlab')) {
      expect(body.sources).toStrictEqual([{ provider: 'gitlab', settings: { labels: 'x', project: 'group/sub/web' } }]);
    }
  });

  it('refuses an unscoped GitHub source for a GitLab target before HTTP', async () => {
    const path = await authoredFlow();
    const calls = cloud({});
    await expect(deployToCloud({ path, repository: parseRepository('gitlab:g/p'), sources: [parseTriggerSource('github')], approver: 'k' }))
      .rejects.toMatchObject({ code: 'invalid_input', message: expect.stringContaining('--on github:repository=owner/name') });
    expect(calls).toEqual([]);
  });

  it.each([
    ['gitlab:g/p', 'github:repository=other/repo', { repository: 'other/repo' }],
    ['gitlab:g/p', 'gitlab:project=other/project', { project: 'other/project' }],
    ['o/r', 'gitlab', {}],
  ])('preserves explicit or cross-host source scope for %s %s', async (repo, trigger, settings) => {
    const path = await authoredFlow();
    cloud({ '/api/v1/auth/whoami': () => WHOAMI,
      '/api/v1/flows/deploy': () => ({ status: 201, body: { agentId: 'a', status: 'listening' } }) });
    const result = await deployToCloud({ path, repository: parseRepository(repo), sources: [parseTriggerSource(trigger)], approver: 'k' });
    expect(result.sources[0]!.settings).toStrictEqual(settings);
  });

  it('refuses a declared harness Cloud cannot run instead of substituting Claude, unless --agents says so', async () => {
    const dir = await tempDir('cloud-deploy-gemini-');
    await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
    const path = join(dir, 'gemini.flow.ts');
    await writeFile(path, "import { flow } from '@relayflows/surface';\n"
      + "export default flow('gemini', async (f) => { await f.agent('review', { task: 't', cli: 'gemini' }); f.done('success'); });\n");
    const calls = cloud({
      '/api/v1/auth/whoami': () => WHOAMI,
      '/api/v1/flows/deploy': () => ({ status: 201, body: { agentId: 'agent-1', status: 'listening' } }),
    });
    const base = { path, repository: { owner: 'o', name: 'r' }, sources: [parseTriggerSource('github')], approver: 'k' };
    await expect(deployToCloud(base)).rejects.toMatchObject({
      code: 'unsupported_source', message: expect.stringContaining('gemini (agent "review")'),
    });
    expect(calls.filter(c => c.path === '/api/v1/flows/deploy')).toEqual([]);
    await deployToCloud({ ...base, agents: ['claude'] });
    expect((calls.at(-1)!.body as { inputs: { agents: string[] } }).inputs.agents).toEqual(['claude']);
  });

  it('defaults --agents to the harnesses the source declares', async () => {
    const dir = await tempDir('cloud-deploy-codex-');
    await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
    const path = join(dir, 'codex.flow.ts');
    await writeFile(path, "import { flow } from '@relayflows/surface';\n"
      + "export default flow('codex', async (f) => { await f.agent('review', { task: 't', cli: 'codex' }); await f.llm('x', { output: {}, cli: 'claude' }); f.done('success'); });\n");
    const calls = cloud({
      '/api/v1/auth/whoami': () => WHOAMI,
      '/api/v1/flows/deploy': () => ({ status: 201, body: { agentId: 'agent-1', status: 'listening' } }),
    });
    await deployToCloud({ path, repository: { owner: 'o', name: 'r' }, sources: [parseTriggerSource('github')], approver: 'k' });
    const body = calls.at(-1)!.body as { inputs: { agents: string[] }; requirements: { harnesses: string[] } };
    expect(body.inputs.agents).toEqual(['codex', 'claude']);
    expect(body.requirements.harnesses).toEqual(['codex', 'claude']);
  });

  it('reports a missing or unloadable source as an input refusal (exit 2), before HTTP', async () => {
    const calls = cloud({});
    const base = { repository: { owner: 'o', name: 'r' }, sources: [parseTriggerSource('github')], approver: 'k' };
    await expect(deployToCloud({ ...base, path: join(await tempDir('cloud-deploy-missing-'), 'nope.flow.ts') }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    const dir = await tempDir('cloud-deploy-broken-');
    await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
    await writeFile(join(dir, 'broken.flow.ts'), 'export default 42;\n');
    await expect(deployToCloud({ ...base, path: join(dir, 'broken.flow.ts') }))
      .rejects.toMatchObject({ code: 'unsupported_source' });
    const errors: string[] = [];
    expect(await runCli(['deploy', join(dir, 'broken.flow.ts'), '--repo', 'o/r', '--on', 'github', '--approver', 'k'],
      { stdout: () => {}, stderr: line => errors.push(line) })).toBe(2);
    expect(calls).toHaveLength(0);
  });

  it('refuses non-authored sources, empty sources, duplicate providers and a blank approver before HTTP', async () => {
    const path = await authoredFlow();
    const calls = cloud({});
    const base = { path, repository: { owner: 'o', name: 'r' }, sources: [parseTriggerSource('github')], approver: 'k' };
    await expect(deployToCloud({ ...base, path: 'flow.yaml' })).rejects.toMatchObject({ code: 'unsupported_source' });
    await expect(deployToCloud({ ...base, sources: [] })).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(deployToCloud({ ...base, sources: [parseTriggerSource('github'), parseTriggerSource('github')] }))
      .rejects.toMatchObject({ code: 'invalid_input' });
    await expect(deployToCloud({ ...base, approver: '  ' })).rejects.toMatchObject({ code: 'invalid_input' });
    expect(calls).toHaveLength(0);
  });
});

describe('flows deploy / flows deployments', () => {
  it('deploys an authored flow as a listener and prints the sources', async () => {
    const path = await authoredFlow('triage');
    cloud({
      '/api/v1/auth/whoami': () => WHOAMI,
      '/api/v1/flows/deploy': () => ({ status: 201, body: { agentId: 'agent-9', status: 'listening' } }),
    });
    const out: string[] = [];
    const code = await runCli(['deploy', path, '--repo', 'AgentWorkforce/flows', '--on', 'github:labels=agent', '--approver', 'khaliqgant'],
      { stdout: line => out.push(line), stderr: line => out.push(`ERR ${line}`) });
    expect(code, out.join('\n')).toBe(0);
    expect(out[0]).toBe('DEPLOYED agent-9 listening');
    expect(out).toContainEqual('  repository: AgentWorkforce/flows');
    expect(out).toContainEqual('  on: github labels=agent repository=AgentWorkforce/flows');
  });

  it.each([false, true])('deploys and lists GitLab repositories (json=%s)', async (json) => {
    const path = await authoredFlow();
    const repository = { owner: 'group/sub', name: 'web', host: 'gitlab' };
    cloud({
      '/api/v1/auth/whoami': () => WHOAMI,
      '/api/v1/flows/deploy': () => ({ status: 201, body: { agentId: 'a', status: 'listening' } }),
      '/api/v1/agents/flow-deployments': () => ({ deployments: [{ agentId: 'a', name: 'Garden', status: 'listening', repository, sources: [] }] }),
    });
    const out: string[] = [];
    const io = { stdout: (line: string) => out.push(line), stderr: (line: string) => out.push(`ERR ${line}`) };
    const flags = json ? ['--json'] : [];
    expect(await runCli(['deploy', path, '--repo', 'gitlab:group/sub/web', '--on', 'gitlab:labels=x', '--approver', 'k', ...flags], io), out.join('\n')).toBe(0);
    if (json) expect(JSON.parse(out[0]!).repository).toStrictEqual(repository);
    else {
      expect(out).toContain('  repository: gitlab:group/sub/web');
      expect(out).toContain('  requires: gitlab (--on gitlab)');
    }
    out.length = 0;
    expect(await runCli(['deployments', ...flags], io)).toBe(0);
    if (json) expect(JSON.parse(out[0]!).deployments[0].repository).toStrictEqual(repository);
    else expect(out).toEqual(['a listening "Garden" gitlab:group/sub/web']);
  });

  it('passes --agents and --draft through, and names a structured refusal', async () => {
    const path = await authoredFlow('drafted');
    const calls = cloud({
      '/api/v1/auth/whoami': () => WHOAMI,
      '/api/v1/flows/deploy': (call) => (call.body as { mode: string }).mode === 'draft'
        ? { status: 201, body: { agentId: 'agent-d', status: 'draft' } }
        : { status: 409, body: { error: 'Connect an active codex subscription before activating this flow.', code: 'flow_model_not_connected' } },
    });
    const out: string[] = [];
    expect(await runCli(['deploy', path, '--repo', 'o/r', '--on', 'github', '--approver', 'k', '--agents', 'claude,codex', '--draft'],
      { stdout: line => out.push(line), stderr: line => out.push(`ERR ${line}`) })).toBe(0);
    expect(out[0]).toBe('SAVED agent-d draft');
    expect(calls.at(-1)!.body).toMatchObject({ mode: 'draft', inputs: { approver: 'k', agents: ['claude', 'codex'] } });
    const errors: string[] = [];
    expect(await runCli(['deploy', path, '--repo', 'o/r', '--on', 'github', '--approver', 'k', '--agents', 'codex'],
      { stdout: () => {}, stderr: line => errors.push(line) })).toBe(1);
    expect(errors[0]).toContain('flow_model_not_connected');
    expect(errors[0]).toContain('codex subscription');
    expect(() => parseAgentHarnesses('gemini')).toThrow(expect.objectContaining({ code: 'invalid_input' }));
    expect(() => parseAgentHarnesses('claude,claude')).toThrow(expect.objectContaining({ code: 'invalid_input' }));
  });

  it('explains a 403 as a missing cli:auth login and exits 2', async () => {
    const path = await authoredFlow();
    cloud({
      '/api/v1/auth/whoami': () => WHOAMI,
      '/api/v1/flows/deploy': () => ({ status: 403, body: { error: 'Forbidden', code: 'session_required' } }),
    });
    const errors: string[] = [];
    expect(await runCli(['deploy', path, '--repo', 'o/r', '--on', 'github', '--approver', 'k', '--json'],
      { stdout: line => errors.push(line), stderr: () => {} })).toBe(2);
    expect(JSON.parse(errors[0]!)).toMatchObject({ ok: false, code: 'http_error' });
    expect(errors[0]).toContain('agent-relay cloud login');
  });

  it.each([
    ['deploy', 'x.flow.ts'],
    ['deploy', 'x.flow.ts', '--repo', 'o/r'],
    ['deploy', 'x.flow.ts', '--on', 'github'],
    ['deploy', 'x.flow.ts', '--repo', 'o/r', '--repo', 'p/q', '--on', 'github'],
    ['deploy', 'x.flow.ts', '--repo', 'o/r', '--on'],
    ['deployments', 'extra'],
    ['deployments', '--data-dir', 'x'],
  ])('refuses argv %j before any request', async (...args) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(await runCli(args, { stdout: () => {}, stderr: () => {} })).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('requires --approver with a reason, before any request', async () => {
    const path = await authoredFlow();
    const calls = cloud({});
    const errors: string[] = [];
    expect(await runCli(['deploy', path, '--repo', 'o/r', '--on', 'github'], { stdout: () => {}, stderr: line => errors.push(line) })).toBe(2);
    expect(errors[0]).toContain('--approver');
    expect(calls).toHaveLength(0);
  });

  it('still routes the digest form to the bucket deploy', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    const errors: string[] = [];
    const code = await runCli(['deploy', 'flow@sha256:' + 'a'.repeat(64), '--to', 'file:///nowhere'],
      { stdout: () => {}, stderr: line => errors.push(line) });
    expect(code).toBe(2);
    expect(errors[0]).toContain('bundle_missing_locally');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('lists deployments with their sources', async () => {
    cloud({
      '/api/v1/agents/flow-deployments': () => ({ deployments: [
        { agentId: 'a-1', name: 'Garden', status: 'listening', repository: { owner: 'AgentWorkforce', name: 'flows' },
          sources: [{ provider: 'github', settings: { labels: 'garden-ready', repository: 'AgentWorkforce/flows' } }] },
        { agentId: 'a-2', name: 'Jira', status: 'paused', sources: [{ provider: 'jira', settings: { project: 'OPS' } }] },
      ] }),
    });
    const out: string[] = [];
    expect(await runCli(['deployments'], { stdout: line => out.push(line), stderr: () => {} })).toBe(0);
    expect(out).toEqual([
      'a-1 listening "Garden" AgentWorkforce/flows',
      '  on: github labels=garden-ready repository=AgentWorkforce/flows',
      'a-2 paused "Jira"',
      '  on: jira project=OPS',
    ]);
  });
});

describe('agent-relay cloud login fallback', () => {
  async function loginStore(record: Record<string, unknown>): Promise<void> {
    const home = await tempDir('relay-home-');
    await mkdir(home, { recursive: true });
    await writeFile(join(home, 'cloud-auth.json'), JSON.stringify(record));
    vi.stubEnv('AGENT_RELAY_HOME', home);
    vi.stubEnv('FLOWS_CLOUD_TOKEN', '');
    vi.stubEnv('FLOWS_CLOUD_URL', '');
    // vi.stubEnv('', '') leaves an empty string; emulate "unset" precisely.
    delete process.env['FLOWS_CLOUD_TOKEN'];
    delete process.env['FLOWS_CLOUD_URL'];
  }

  it('uses the login token and its API URL when no explicit credential is configured', async () => {
    await loginStore({ apiUrl: 'https://login.example/cloud', accessToken: 'login-token',
      accessTokenExpiresAt: new Date(Date.now() + 60_000).toISOString() });
    expect(cloudConnection({})).toEqual({ baseUrl: 'https://login.example/cloud', token: 'login-token' });
  });

  it('never sends the login token to a deployment other than the one that issued it', async () => {
    await loginStore({ apiUrl: 'https://login.example/cloud', accessToken: 'login-token' });
    vi.stubEnv('FLOWS_CLOUD_URL', 'https://other.example/cloud');
    expect(() => cloudConnection({})).toThrow(expect.objectContaining({ code: 'configuration' }));
    expect(() => cloudConnection({ apiUrl: 'https://other.example/cloud' })).toThrow(/issued for https:\/\/login\.example\/cloud/u);
    // The same deployment spelled with a trailing slash is still the same deployment.
    expect(cloudConnection({ apiUrl: 'https://login.example/cloud/' })).toEqual({ baseUrl: 'https://login.example/cloud', token: 'login-token' });
  });

  it('lets FLOWS_CLOUD_TOKEN win over the login store', async () => {
    await loginStore({ apiUrl: 'https://login.example/cloud', accessToken: 'login-token' });
    vi.stubEnv('FLOWS_CLOUD_TOKEN', 'explicit');
    expect(cloudConnection({})).toEqual({ baseUrl: 'https://agentrelay.com/cloud', token: 'explicit' });
  });

  it('refuses an expired login with the re-login remedy, and a missing store with the configuration message', async () => {
    await loginStore({ apiUrl: 'https://login.example/cloud', accessToken: 'stale',
      accessTokenExpiresAt: new Date(Date.now() - 1).toISOString() });
    expect(() => cloudConnection({})).toThrow(/agent-relay cloud login/u);
    vi.stubEnv('AGENT_RELAY_HOME', join(await tempDir('relay-home-empty-'), 'nope'));
    expect(() => cloudConnection({})).toThrow(expect.objectContaining({ code: 'configuration' }));
  });
});

describe('flows undeploy', () => {
  it('deletes the listener and reports it', async () => {
    const calls = cloud({ '/api/v1/flows/listeners/agent-9': () => ({ listenerId: 'agent-9', status: 'deleted' }) });
    const out: string[] = [];
    expect(await runCli(['undeploy', 'agent-9'], { stdout: line => out.push(line), stderr: () => {} })).toBe(0);
    expect(out).toEqual(['UNDEPLOYED agent-9']);
    expect(calls.map(c => [c.method, c.path])).toEqual([['DELETE', '/api/v1/flows/listeners/agent-9']]);
  });

  it.each([['undeploy'], ['undeploy', 'a', 'b'], ['undeploy', '--json', '--json', 'a'], ['undeploy', '--dir', 'a']])
  ('refuses argv %j', async (...args) => {
    const fetch = vi.spyOn(globalThis, 'fetch');
    expect(await runCli(args, { stdout: () => {}, stderr: () => {} })).toBe(2);
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe('flow versions (cloud#4115)', () => {
  const LISTENER = '11111111-1111-4111-8111-111111111111';
  const LISTENER_DETAIL = {
    listener: {
      listenerId: LISTENER, name: 'Cloud Software Garden', status: 'listening',
      repository: { owner: 'acme', name: 'web' },
      sources: [{ provider: 'github', settings: { repository: 'acme/web', labels: 'agent' } }],
    },
    activeVersion: { id: 'v3', version: 3, sourceSha256: 'c'.repeat(64), origin: 'cli', createdAt: '2026-10-02T09:00:00.000Z' },
    versions: [
      { id: 'v3', version: 3, sourceSha256: 'c'.repeat(64), origin: 'cli', createdAt: '2026-10-02T09:00:00.000Z' },
      { id: 'v2', version: 2, sourceSha256: 'b'.repeat(64), origin: 'dashboard', createdAt: '2026-10-01T09:00:00.000Z' },
    ],
  };
  const DEPLOYMENTS = { deployments: [
    { agentId: LISTENER, name: 'Cloud Software Garden', status: 'listening', sources: [] },
    { agentId: '22222222-2222-4222-8222-222222222222', name: 'Other', status: 'listening', sources: [] },
  ] };
  function io() {
    const out: string[] = [];
    return { out, io: { stdout: (line: string) => out.push(line), stderr: (line: string) => out.push(`ERR ${line}`) } };
  }

  it('deploys the next version by flow name without --repo, --on or --approver', async () => {
    const path = await authoredFlow('garden');
    const calls = cloud({
      '/api/v1/agents/flow-deployments': () => DEPLOYMENTS,
      [`/api/v1/flows/listeners/${LISTENER}`]: () => LISTENER_DETAIL,
      '/api/v1/auth/whoami': () => WHOAMI,
      [`/api/v1/flows/listeners/${LISTENER}/versions`]: () => ({
        listenerId: LISTENER, status: 'listening', version: { versionId: 'v4', version: 4, previousVersion: 3, change: 'created' },
      }),
    });
    const { out, io: cliIo } = io();
    expect(await runCli(['deploy', path, '--flow', 'cloud software garden'], cliIo), out.join('\n')).toBe(0);
    expect(out[0]).toBe(`DEPLOYED ${LISTENER} listening · version 4 (was 3)`);
    const post = calls.find(call => call.method === 'POST' && call.path.endsWith('/versions'))!;
    // Only the source and what derives from it: no listener settings.
    expect(Object.keys(post.body as object).sort()).toEqual(['requirements', 'source', 'workspaceId']);
    expect(calls.some(call => call.path === '/api/v1/flows/deploy')).toBe(false);
  });

  it('updates a GitLab listener without adding a target integration requirement', async () => {
    const path = await authoredFlow();
    const calls = cloud({
      [`/api/v1/flows/listeners/${LISTENER}`]: () => ({ ...LISTENER_DETAIL, listener: {
        ...LISTENER_DETAIL.listener, repository: { owner: 'group/sub', name: 'web', host: 'gitlab' },
        sources: [{ provider: 'linear', settings: { team: 'ENG' } }],
      } }),
      '/api/v1/auth/whoami': () => WHOAMI,
      [`/api/v1/flows/listeners/${LISTENER}/versions`]: () => ({ listenerId: LISTENER, status: 'listening',
        version: { versionId: 'v4', version: 4, previousVersion: 3, change: 'created' } }),
    });
    const { out, io: cliIo } = io();
    expect(await runCli(['deploy', path, '--flow', LISTENER], cliIo), out.join('\n')).toBe(0);
    const post = calls.find(c => c.method === 'POST')!;
    expect(Object.keys(post.body as object).sort()).toEqual(['requirements', 'source', 'workspaceId']);
    expect(post.body).toMatchObject({ requirements: { integrations: ['linear'] } });
    expect(calls.filter(c => c.path.includes('/integrations/')).map(c => c.path))
      .toEqual(['/api/v1/workspaces/ws-1/integrations/linear/status']);
  });

  it('takes a listener id directly and says when the active version went down', async () => {
    const path = await authoredFlow('garden');
    const calls = cloud({
      [`/api/v1/flows/listeners/${LISTENER}`]: () => LISTENER_DETAIL,
      '/api/v1/auth/whoami': () => WHOAMI,
      [`/api/v1/flows/listeners/${LISTENER}/versions`]: () => ({
        listenerId: LISTENER, status: 'listening', version: { versionId: 'v2', version: 2, previousVersion: 4, change: 'reactivated' },
      }),
    });
    const { out, io: cliIo } = io();
    expect(await runCli(['deploy', path, '--flow', LISTENER], cliIo), out.join('\n')).toBe(0);
    expect(out[0]).toBe(`DEPLOYED ${LISTENER} listening · re-activated version 2 (was 4; active version went down)`);
    expect(calls.some(call => call.path === '/api/v1/agents/flow-deployments')).toBe(false);
  });

  it('refuses listener settings beside --flow by name, before any request', async () => {
    const path = await authoredFlow('garden');
    const calls = cloud({});
    const { out, io: cliIo } = io();
    expect(await runCli(['deploy', path, '--flow', 'x', '--repo', 'o/r', '--on', 'github', '--approver', 'k'], cliIo)).toBe(2);
    expect(out[0]).toContain('--repo, --on, --approver stay on the listener');
    expect(calls).toHaveLength(0);
  });

  it('refuses a source declaring a harness Cloud cannot run, before posting a version', async () => {
    const dir = await tempDir('cloud-deploy-gemini-');
    await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
    const path = join(dir, 'gemini.flow.ts');
    await writeFile(path, "import { flow } from '@relayflows/surface';\n"
      + "export default flow('gemini', { budget: '$5/run' }, async (f) => {\n"
      + "  await f.agent('review', { cli: 'gemini', task: 'review' });\n  f.done('success');\n});\n");
    const calls = cloud({
      [`/api/v1/flows/listeners/${LISTENER}`]: () => LISTENER_DETAIL,
      '/api/v1/auth/whoami': () => WHOAMI,
    });
    const { out, io: cliIo } = io();
    expect(await runCli(['deploy', path, '--flow', LISTENER], cliIo)).toBe(2);
    expect(out[0]).toContain('declares gemini');
    expect(out[0]).toContain('Cloud deployments cannot run');
    expect(calls.some(call => call.method === 'POST')).toBe(false);
  });

  it('addresses a listener by a non-uuid id the workspace lists', async () => {
    cloud({
      '/api/v1/agents/flow-deployments': () => ({ deployments: [{ agentId: 'agent-9', name: 'Garden', status: 'listening', sources: [] }] }),
      '/api/v1/flows/listeners/agent-9/versions/2/activate': () => ({
        listenerId: 'agent-9', status: 'listening', version: { versionId: 'v2', version: 2, previousVersion: 3, change: 'reactivated' },
      }),
    });
    const { out, io: cliIo } = io();
    expect(await runCli(['rollback', 'agent-9', '2'], cliIo), out.join('\n')).toBe(0);
    expect(out[0]).toContain('ACTIVATED agent-9 listening');
  });

  it('names an unknown or ambiguous flow', async () => {
    const path = await authoredFlow('garden');
    cloud({ '/api/v1/agents/flow-deployments': () => ({ deployments: [
      ...DEPLOYMENTS.deployments, { agentId: '33333333-3333-4333-8333-333333333333', name: 'Other', status: 'draft', sources: [] },
    ] }) });
    const missing = io();
    expect(await runCli(['deploy', path, '--flow', 'Nope'], missing.io)).toBe(2);
    expect(missing.out[0]).toContain('No flow named "Nope"');
    const ambiguous = io();
    expect(await runCli(['deploy', path, '--flow', 'other'], ambiguous.io)).toBe(2);
    expect(ambiguous.out[0]).toContain('pass the listener id');
  });

  it('reports the version a create-form deploy made', async () => {
    const path = await authoredFlow('triage');
    cloud({
      '/api/v1/auth/whoami': () => WHOAMI,
      '/api/v1/flows/deploy': () => ({ status: 201, body: {
        agentId: 'agent-9', status: 'listening', version: { versionId: 'v1', version: 1, previousVersion: null, change: 'created' },
      } }),
    });
    const { out, io: cliIo } = io();
    expect(await runCli(['deploy', path, '--repo', 'o/r', '--on', 'github', '--approver', 'k'], cliIo)).toBe(0);
    expect(out[0]).toBe('DEPLOYED agent-9 listening · version 1');
  });

  it('lists versions with the active one marked, and rolls back', async () => {
    const calls = cloud({
      '/api/v1/agents/flow-deployments': () => DEPLOYMENTS,
      [`/api/v1/flows/listeners/${LISTENER}`]: () => LISTENER_DETAIL,
      [`/api/v1/flows/listeners/${LISTENER}/versions/2/activate`]: () => ({
        listenerId: LISTENER, status: 'listening', version: { versionId: 'v2', version: 2, previousVersion: 3, change: 'reactivated' },
      }),
    });
    const listed = io();
    expect(await runCli(['versions', 'Cloud Software Garden'], listed.io)).toBe(0);
    expect(listed.out[1]).toMatch(/^ {2}version 3 \(active\) /u);
    expect(listed.out[2]).toMatch(/^ {2}version 2 {2}2026-10-01/u);
    const rolled = io();
    expect(await runCli(['rollback', 'Cloud Software Garden', '2'], rolled.io)).toBe(0);
    expect(rolled.out[0]).toBe(`ACTIVATED ${LISTENER} listening · re-activated version 2 (was 3; active version went down)`);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: `/api/v1/flows/listeners/${LISTENER}/versions/2/activate` });
    for (const version of ['two', '0', '9007199254740993']) {
      const bad = io();
      expect(await runCli(['rollback', 'Cloud Software Garden', version], bad.io)).toBe(2);
    }
  });
});
