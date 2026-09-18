import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { runCli } from '../src/cli.js';
import { cliConnectPrompt, harnessRemedy } from '../src/cli/cloud-connect-cli.js';
import { ensureIntegrationsConnected, integrationConnected, providerLabel, type ConnectPrompt } from '../src/cloud-connect.js';
import { CloudFlowError } from '../src/cloud-http.js';

const dirs: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
});

interface Call { method: string; path: string; query: URLSearchParams; body: unknown }
type Route = (call: Call) => { status?: number; body: unknown } | unknown;

/** A Cloud whose routes are exact paths; a missing route answers 404 like the real one. */
function cloud(routes: Record<string, Route>) {
  const calls: Call[] = [];
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input, init) => {
    init?.signal?.throwIfAborted();
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? 'GET', path: url.pathname, query: url.searchParams,
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined };
    calls.push(call);
    const route = routes[call.path];
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
const STATUS = '/api/v1/workspaces/ws-1/integrations/slack/status';
const SESSION = '/api/v1/workspaces/ws-1/integrations/connect-session';
const SLACK = { integrations: [{ provider: 'slack', from: 'tools' as const, detail: 'tools.slack' }] };
const noSleep = async () => {};

function prompt(answer: boolean, opened: string[] = [], lines: string[] = []): ConnectPrompt {
  return { confirm: async () => answer, info: line => lines.push(line), openUrl: url => { opened.push(url); } };
}

async function slackFlow(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'cloud-connect-'));
  dirs.push(dir);
  await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
  const path = join(dir, 'digest.flow.ts');
  await writeFile(path, "import { flow } from '@relayflows/surface';\n"
    + "export default flow<{ channel: string }>('digest', { tools: { slack: true } }, async (f, input) => {\n"
    + "  await f.slack.post(input.channel, 'hi');\n  f.done('success');\n});\n");
  return path;
}

describe('integrationConnected', () => {
  it('asks the workspace-scoped status route and reads ready', async () => {
    const calls = cloud({ [STATUS]: () => ({ ready: true, state: 'ready', provider: 'slack' }) });
    expect(await integrationConnected('ws-1', 'slack', {})).toBe(true);
    expect(calls[0]!.query.get('scope')).toBe('workspace');
    cloud({ [STATUS]: () => ({ ready: false, state: 'pending' }) });
    expect(await integrationConnected('ws-1', 'slack', {})).toBe(false);
  });

  it('falls back to the integrations list when Cloud has no status route', async () => {
    cloud({ '/api/v1/workspaces/ws-1/integrations': () => [{ provider: 'github', status: 'connected' }, { provider: 'slack', status: 'error' }] });
    expect(await integrationConnected('ws-1', 'github', {})).toBe(true);
    expect(await integrationConnected('ws-1', 'slack', {})).toBe(false);
  });

  it('names a provider Cloud does not know instead of treating it as disconnected', async () => {
    cloud({ [STATUS]: () => ({ status: 404, body: { error: 'Unknown integration provider', code: 'unknown_provider' } }) });
    await expect(integrationConnected('ws-1', 'slack', {}))
      .rejects.toMatchObject({ code: 'integration_not_connected', message: expect.stringContaining('"slack" is not an integration') });
    await expect(integrationConnected('ws-1', 'Bad Provider', {})).rejects.toMatchObject({ code: 'invalid_input' });
  });
});

describe('ensureIntegrationsConnected', () => {
  it('passes straight through when everything is ready', async () => {
    cloud({ [STATUS]: () => ({ ready: true }) });
    expect(await ensureIntegrationsConnected(SLACK, { workspaceId: 'ws-1', prompt: prompt(true) }))
      .toEqual({ ready: ['slack'], connected: [] });
  });

  it('refuses with the provider, the declaration and the remedy when there is no prompt', async () => {
    const calls = cloud({ [STATUS]: () => ({ ready: false }) });
    await expect(ensureIntegrationsConnected(SLACK, { workspaceId: 'ws-1' })).rejects.toMatchObject({
      code: 'integration_not_connected',
      message: expect.stringMatching(/^Slack is not connected to this workspace, and this flow needs it \(tools\.slack\)\. .*--no-connect/u),
    });
    expect(calls.map(c => c.path)).toEqual([STATUS]);
  });

  it('refuses when the prompt declines, without opening a session', async () => {
    const calls = cloud({ [STATUS]: () => ({ ready: false }) });
    await expect(ensureIntegrationsConnected(SLACK, { workspaceId: 'ws-1', prompt: prompt(false) }))
      .rejects.toMatchObject({ code: 'integration_not_connected' });
    expect(calls.some(c => c.path === SESSION)).toBe(false);
  });

  it('opens the connect session in the browser and polls the status until ready', async () => {
    let polls = 0;
    const calls = cloud({
      [STATUS]: () => ({ ready: polls++ >= 2 }),
      [SESSION]: () => ({ connectLink: 'https://cloud-contract.example/connect/abc', token: 't', workspaceId: 'ws-1' }),
    });
    const opened: string[] = [];
    const lines: string[] = [];
    const outcome = await ensureIntegrationsConnected(SLACK,
      { workspaceId: 'ws-1', prompt: prompt(true, opened, lines), sleep: noSleep, pollIntervalMs: 1 });
    expect(outcome).toEqual({ ready: [], connected: ['slack'] });
    const session = calls.find(c => c.path === SESSION)!;
    expect(session.method).toBe('POST');
    expect(session.body).toEqual({ allowedIntegrations: ['slack'], scope: { kind: 'workspace' } });
    expect(opened).toEqual(['https://cloud-contract.example/connect/abc']);
    expect(calls.filter(c => c.path === STATUS)).toHaveLength(3);
    expect(lines).toContain('Slack connected.');
    expect(lines[0]).toBe('This flow needs Slack (tools.slack), which is not connected to this workspace.');
  });

  it('accepts the older sessionUrl name and refuses a non-https link', async () => {
    cloud({ [STATUS]: () => ({ ready: false }), [SESSION]: () => ({ sessionUrl: 'http://cloud-contract.example/connect/abc' }) });
    await expect(ensureIntegrationsConnected(SLACK, { workspaceId: 'ws-1', prompt: prompt(true), sleep: noSleep }))
      .rejects.toMatchObject({ code: 'invalid_response' });
  });

  it('gives up after the connect timeout and says where to finish', async () => {
    cloud({ [STATUS]: () => ({ ready: false }), [SESSION]: () => ({ connectLink: 'https://cloud-contract.example/connect/abc' }) });
    await expect(ensureIntegrationsConnected(SLACK,
      { workspaceId: 'ws-1', prompt: prompt(true), sleep: noSleep, pollIntervalMs: 1, connectTimeoutMs: 0 }))
      .rejects.toMatchObject({ code: 'integration_not_connected', message: expect.stringContaining('https://cloud-contract.example/connect/abc') });
  });

  it('surfaces a refused connect session as Cloud named it', async () => {
    cloud({ [STATUS]: () => ({ ready: false }), [SESSION]: () => ({ status: 403, body: { error: 'Forbidden' } }) });
    await expect(ensureIntegrationsConnected(SLACK, { workspaceId: 'ws-1', prompt: prompt(true), sleep: noSleep }))
      .rejects.toMatchObject({ code: 'http_error', status: 403 });
  });

  it('labels providers for people', () => {
    expect(providerLabel('github')).toBe('GitHub');
    expect(providerLabel('google-mail')).toBe('Google Mail');
    expect(providerLabel('slack')).toBe('Slack');
  });
});

describe('cliConnectPrompt', () => {
  const io = { stdout: () => {}, stderr: () => {} };
  const tty = (): { stdin: NodeJS.ReadStream; stdout: NodeJS.WriteStream } => {
    const stdin = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.ReadStream;
    const stdout = Object.assign(new PassThrough(), { isTTY: true }) as unknown as NodeJS.WriteStream;
    return { stdin, stdout };
  };

  it('is absent under --no-connect, --json, or without a terminal', () => {
    expect(cliConnectPrompt(io, { noConnect: true, json: false }, tty())).toBeUndefined();
    expect(cliConnectPrompt(io, { noConnect: false, json: true }, tty())).toBeUndefined();
    const pipe = tty();
    (pipe.stdin as unknown as { isTTY: boolean }).isTTY = false;
    expect(cliConnectPrompt(io, { noConnect: false, json: false }, pipe)).toBeUndefined();
  });

  it('reads an empty line or y as yes and anything else as no', async () => {
    for (const [answer, expected] of [['\n', true], ['y\n', true], ['YES\n', true], ['n\n', false], ['later\n', false]] as const) {
      const streams = tty();
      const asked = cliConnectPrompt(io, { noConnect: false, json: false }, streams)!;
      const pending = asked.confirm('Connect Slack now? (opens browser) [Y/n] ');
      (streams.stdin as unknown as PassThrough).write(answer);
      expect(await pending, JSON.stringify(answer)).toBe(expected);
    }
  });
});

describe('harnessRemedy', () => {
  it('names agent-relay cloud connect for the harness Cloud refused', () => {
    const refused = (code: string, error: string) => new CloudFlowError('http_error', `Cloud refused (${code}): ${error}`, 409, { code, error });
    expect(harnessRemedy(refused('flow_model_not_connected', 'Connect an active codex subscription before activating this flow.'), ['claude', 'codex']))
      .toBe(' Connect it with: agent-relay cloud connect codex.');
    expect(harnessRemedy(refused('flow_model_not_connected', 'Connect a subscription first.'), ['codex']))
      .toBe(' Connect it with: agent-relay cloud connect codex.');
    expect(harnessRemedy(refused('flow_model_not_connected', 'Connect a subscription first.'), []))
      .toBe(' Connect it with: agent-relay cloud connect claude.');
    expect(harnessRemedy(refused('cli_credentials_missing', "Run 'agent-relay cloud connect claude' first."), ['claude'])).toBe('');
    expect(harnessRemedy(refused('flow_source_not_connected', 'Connect slack first.'), ['claude'])).toBe('');
    expect(harnessRemedy(new Error('boom'), ['claude'])).toBe('');
  });
});

describe('hosted verbs connect before they submit', () => {
  it('flows deploy --no-connect refuses an unconnected helper integration before posting, exit 2', async () => {
    const path = await slackFlow();
    const calls = cloud({
      '/api/v1/auth/whoami': () => WHOAMI,
      '/api/v1/workspaces/ws-1/integrations/github/status': () => ({ ready: true }),
      [STATUS]: () => ({ ready: false }),
      '/api/v1/flows/deploy': () => ({ status: 201, body: { agentId: 'a', status: 'listening' } }),
    });
    const stderr: string[] = [];
    const code = await runCli(['deploy', path, '--repo', 'o/r', '--on', 'github', '--approver', 'k', '--no-connect'],
      { stdout: () => {}, stderr: line => stderr.push(line) });
    expect(code).toBe(2);
    expect(stderr[0]).toMatch(/^integration_not_connected: Slack is not connected to this workspace, and this flow needs it \(tools\.slack\)/u);
    // Declarations are checked in requirement order (header first), and the
    // first missing one refuses: GitHub's status is never asked for.
    expect(calls.map(c => c.path)).toEqual(['/api/v1/auth/whoami', STATUS]);
  });

  it('flows deploy --json never prompts and reports the refusal as JSON', async () => {
    const path = await slackFlow();
    cloud({ '/api/v1/auth/whoami': () => WHOAMI, '/api/v1/workspaces/ws-1/integrations/github/status': () => ({ ready: true }), [STATUS]: () => ({ ready: false }) });
    const out: string[] = [];
    expect(await runCli(['deploy', path, '--repo', 'o/r', '--on', 'github', '--approver', 'k', '--json'], { stdout: l => out.push(l), stderr: () => {} })).toBe(2);
    expect(JSON.parse(out[0]!)).toMatchObject({ ok: false, code: 'integration_not_connected' });
  });

  it('flows deploy --draft skips the check, like Cloud does for a draft', async () => {
    const path = await slackFlow();
    const calls = cloud({
      '/api/v1/auth/whoami': () => WHOAMI,
      '/api/v1/flows/deploy': () => ({ status: 201, body: { agentId: 'a', status: 'draft' } }),
    });
    const out: string[] = [];
    expect(await runCli(['deploy', path, '--repo', 'o/r', '--on', 'github', '--approver', 'k', '--draft'], { stdout: l => out.push(l), stderr: () => {} })).toBe(0);
    expect(calls.map(c => c.path)).toEqual(['/api/v1/auth/whoami', '/api/v1/flows/deploy']);
    expect(out).toContain('  requires: slack (tools.slack), github (--on github)');
  });

  it('flows deploy appends the agent-relay cloud connect remedy to a harness refusal', async () => {
    const path = await slackFlow();
    cloud({
      '/api/v1/auth/whoami': () => WHOAMI,
      '/api/v1/workspaces/ws-1/integrations/github/status': () => ({ ready: true }),
      [STATUS]: () => ({ ready: true }),
      '/api/v1/flows/deploy': () => ({ status: 409, body: { code: 'flow_model_not_connected', error: 'Connect an active claude subscription before activating this flow.' } }),
    });
    const stderr: string[] = [];
    expect(await runCli(['deploy', path, '--repo', 'o/r', '--on', 'github', '--approver', 'k', '--no-connect'], { stdout: () => {}, stderr: l => stderr.push(l) })).toBe(1);
    expect(stderr[0]).toContain('Connect it with: agent-relay cloud connect claude.');
  });

  it('flows run --cloud refuses before packing or submitting anything', async () => {
    const path = await slackFlow();
    const calls = cloud({ '/api/v1/auth/whoami': () => WHOAMI, [STATUS]: () => ({ ready: false }) });
    const stderr: string[] = [];
    expect(await runCli(['run', '--cloud', '--no-connect', path, '--input', '{"channel":"#eng"}'], { stdout: () => {}, stderr: l => stderr.push(l) })).toBe(2);
    expect(stderr[0]).toMatch(/^integration_not_connected: Slack is not connected/u);
    expect(calls.map(c => c.path)).toEqual(['/api/v1/auth/whoami', STATUS]);
  });

  it('flows run --cloud submits once the prompt connected the integration', async () => {
    const path = await slackFlow();
    let polls = 0;
    const calls = cloud({
      '/api/v1/auth/whoami': () => WHOAMI,
      [STATUS]: () => ({ ready: polls++ >= 1 }),
      [SESSION]: () => ({ connectLink: 'https://cloud-contract.example/connect/abc' }),
      '/api/v1/workflows/run': () => ({ status: 500, body: { error: 'stop here' } }),
    });
    // A terminal that answers yes: stdin and stdout are TTYs and the first line is empty.
    const stdin = Object.assign(new PassThrough(), { isTTY: true });
    const stdout = Object.assign(new PassThrough(), { isTTY: true });
    vi.spyOn(process, 'stdin', 'get').mockReturnValue(stdin as unknown as NodeJS.ReadStream);
    vi.spyOn(process, 'stdout', 'get').mockReturnValue(stdout as unknown as NodeJS.WriteStream);
    vi.stubEnv('FLOWS_NO_BROWSER', '1');
    setTimeout(() => stdin.write('\n'), 10);
    const out: string[] = [];
    const errors: string[] = [];
    const code = await runCli(['run', '--cloud', path, '--input', '{"channel":"#eng"}'], { stdout: l => out.push(l), stderr: l => errors.push(l) });
    expect(code).toBe(1);
    expect(out).toContain('CONNECTED slack');
    expect(errors).toContain('Slack connected.');
    expect(calls.map(c => c.path)).toEqual([
      '/api/v1/auth/whoami', STATUS, SESSION, STATUS, '/api/v1/workflows/run',
    ]);
  }, 20_000);

  it('flows schedule refuses an unconnected integration before creating the schedule', async () => {
    const path = await slackFlow();
    const calls = cloud({ '/api/v1/auth/whoami': () => WHOAMI, [STATUS]: () => ({ ready: false }) });
    const stderr: string[] = [];
    expect(await runCli(['schedule', path, '--every', '5m', '--input', '{"channel":"#eng"}', '--no-connect'], { stdout: () => {}, stderr: l => stderr.push(l) })).toBe(2);
    expect(stderr[0]).toMatch(/^integration_not_connected: Slack is not connected/u);
    expect(calls.map(c => c.path)).toEqual(['/api/v1/auth/whoami', STATUS]);
  });

  it('a flow with no integrations contacts nothing extra', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'cloud-connect-plain-'));
    dirs.push(dir);
    await symlink(join(process.cwd(), 'node_modules'), join(dir, 'node_modules'), 'dir');
    const path = join(dir, 'plain.flow.ts');
    await writeFile(path, "import { flow } from '@relayflows/surface';\nexport default flow('plain', async (f) => { await f.run('true'); f.done('success'); });\n");
    const calls = cloud({ '/api/v1/workflows/schedules': () => ({ status: 500, body: { error: 'stop here' } }) });
    await runCli(['schedule', path, '--every', '5m', '--input', '{}'], { stdout: () => {}, stderr: () => {} });
    expect(calls.map(c => c.path)).toEqual(['/api/v1/workflows/schedules']);
  });
});
