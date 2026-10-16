import { createConnection } from 'node:net';
import { once } from 'node:events';
import { it, expect, vi } from 'vitest';
import { CommunicationSession } from '../src/communication/session.js';
import { createProjection } from '../src/communication/projection.js';
import { openCommunicationTools } from '../src/communication/tools.js';
import { agentEnvironment, brokerEnvironment, providerEnvironmentCliNames } from '../src/communication/environment.js';
import type { RelayMessaging, RelayRuntime } from '../src/communication/relay.js';
import type { JournalClient } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';

it.each(['create', 'send', 'hanging'])('observer %s failure cannot block processing or completion', async failure => {
  const diagnostic = vi.fn();
  const messaging = { channels: {
    create: vi.fn(async () => { if (failure === 'create') throw Error('channel outage'); }),
    get: vi.fn(async () => { throw Error('channel outage'); }), join: vi.fn(),
  }, messages: {
    direct: vi.fn(async () => ({ id: 'delivered' })),
    send: vi.fn(async () => { if (failure === 'hanging') await new Promise(() => {}); else throw Error('projection outage'); }),
  } } as unknown as RelayMessaging;
  const runtime = { prefix: 'flow', project: createProjection(messaging, 'wf-run', 'run', diagnostic), messaging } as RelayRuntime;
  const client = { channelReceive: vi.fn(async () => ({ seq: 7, payload: { message: 'hello' } })), channelAck: vi.fn() };
  const complete = vi.fn();
  const fatal = vi.fn();
  const session = new CommunicationSession(client as unknown as JournalClient,
    { run_id: 'run', step_id: 'b', attempt: 1, idempotency_key: 'key' } as StepDispatchEvent,
    { type: 'relayflows.communication.v1', instruction: '', incoming: ['a'], outgoing: [], timeoutMs: 1000 }, runtime, complete, fatal);
  await session.pump();
  await session.pump();
  expect(messaging.messages.direct).toHaveBeenCalledTimes(1);
  expect(client.channelAck).not.toHaveBeenCalled();
  await session.invoke({ operation: 'ack', values: ['a', '7'] });
  await session.invoke({ operation: 'complete', values: ['processed'] });
  await vi.waitFor(() => expect(complete).toHaveBeenCalledWith('processed'));
  expect(fatal).not.toHaveBeenCalled();
  if (failure !== 'hanging') expect(diagnostic).toHaveBeenCalledWith(expect.objectContaining({ kind: 'communication_projection_failed' }));
});

it('does not carry ambient secrets into the broker, and scopes provider credentials to each CLI', () => {
  const source = { PATH: '/bin', HOME: '/home/test', RELAY_BASE_URL: 'http://localhost',
    GITHUB_TOKEN: 'unrelated', AWS_SECRET_ACCESS_KEY: 'unrelated', NODE_OPTIONS: '--require unsafe',
    OPENAI_API_KEY: 'codex-key', ANTHROPIC_API_KEY: 'claude-key', RELAY_API_KEY: 'workspace-key' };
  // The driver overlays options.env on process.env before Node spawns.
  const merged = { ...source, ...brokerEnvironment(source) };
  expect(Object.entries(merged).filter(([, value]) => value !== undefined)).toEqual([
    ['PATH', '/bin'], ['HOME', '/home/test'], ['RELAY_BASE_URL', 'http://localhost'],
  ]);
  expect(agentEnvironment('codex', source)).toMatchObject({ OPENAI_API_KEY: 'codex-key', RELAY_API_KEY: '', RELAY_BROKER_API_KEY: '' });
  expect(agentEnvironment('codex', source)).not.toHaveProperty('ANTHROPIC_API_KEY');
  expect(agentEnvironment('claude', source)).not.toHaveProperty('OPENAI_API_KEY');
  expect(agentEnvironment('/custom/cli', source)).not.toHaveProperty('GITHUB_TOKEN');
});

it('communication agents drop delivered secrets by default on a scoped runtime', () => {
  const source = {
    ANTHROPIC_API_KEY: 'delivered-provider-key',
    CLAUDE_CODE_OAUTH_TOKEN: 'own-login',
    NATIVE_API_TOKEN: 'delivered-native-key',
    RELAY_API_KEY: 'broker-key',
    RELAY_SECRET_ENV_NAMES: JSON.stringify(['ANTHROPIC_API_KEY', 'NATIVE_API_TOKEN']),
  };
  const plain = agentEnvironment('claude', source);
  expect(plain).not.toHaveProperty('ANTHROPIC_API_KEY');
  expect(plain).not.toHaveProperty('NATIVE_API_TOKEN');
  expect(plain.CLAUDE_CODE_OAUTH_TOKEN).toBe('own-login');
  const granted = agentEnvironment('claude', source, ['NATIVE_API_TOKEN']);
  expect(granted.NATIVE_API_TOKEN).toBe('delivered-native-key');
  expect(granted).not.toHaveProperty('ANTHROPIC_API_KEY');
  expect(granted.RELAY_API_KEY).toBe('');
  expect(agentEnvironment('claude', source, undefined, false)).not.toHaveProperty('ANTHROPIC_API_KEY');
  expect(() => agentEnvironment('claude', {
    ...source, RELAY_SECRET_ENV_NAMES: JSON.stringify(['RELAY_API_KEY']),
  }, ['RELAY_API_KEY'])).toThrow('Relay broker credentials');
});

it('legacy communication agents still strip delivered repository names', () => {
  const source = {
    GH_TOKEN: 'user-github-secret', GITLAB_TOKEN: 'user-gitlab-secret',
    GIT_CONFIG_KEY_1: 'user-git-secret', HTTPS_PROXY: 'user-proxy-secret',
    GH_CONFIG_DIR: '/trusted/gh',
    CLAUDE_CODE_USE_BEDROCK: '1', AWS_BEARER_TOKEN_BEDROCK: 'selected-bedrock-login',
    RELAY_SECRET_ENV_NAMES: JSON.stringify([
      'GH_TOKEN', 'GITLAB_TOKEN', 'GIT_CONFIG_KEY_1', 'HTTPS_PROXY',
      'CLAUDE_CODE_USE_BEDROCK', 'AWS_BEARER_TOKEN_BEDROCK',
    ]),
    RELAY_PLATFORM_AGENT_ENV_NAMES: JSON.stringify([
      'CLAUDE_CODE_USE_BEDROCK', 'AWS_BEARER_TOKEN_BEDROCK',
    ]),
  };
  const env = agentEnvironment('claude', source, undefined, false);
  for (const name of ['GH_TOKEN', 'GITLAB_TOKEN', 'GIT_CONFIG_KEY_1', 'HTTPS_PROXY']) {
    expect(env).not.toHaveProperty(name);
  }
  expect(env).toMatchObject({ GH_CONFIG_DIR: '/trusted/gh',
    CLAUDE_CODE_USE_BEDROCK: '1', AWS_BEARER_TOKEN_BEDROCK: 'selected-bedrock-login' });
});

it('communication Claude keeps trusted Bedrock and repository setup without user secrets', () => {
  const source = {
    CLAUDE_CODE_USE_BEDROCK: '1', AWS_BEARER_TOKEN_BEDROCK: 'bedrock-login',
    AWS_REGION: 'eu-west-1', GH_CONFIG_DIR: '/tmp/gh', GIT_ASKPASS: '/tmp/askpass',
    GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
    HTTPS_PROXY: 'https://proxy.example.test',
    USER_SECRET: 'user-secret',
    RELAY_SECRET_ENV_NAMES: '["CLAUDE_CODE_USE_BEDROCK","AWS_BEARER_TOKEN_BEDROCK","USER_SECRET"]',
    RELAY_PLATFORM_AGENT_ENV_NAMES: '["CLAUDE_CODE_USE_BEDROCK","AWS_BEARER_TOKEN_BEDROCK","AWS_REGION"]',
  };
  const env = agentEnvironment('claude', source);
  expect(env).toMatchObject({ CLAUDE_CODE_USE_BEDROCK: '1', AWS_BEARER_TOKEN_BEDROCK: 'bedrock-login',
    AWS_REGION: 'eu-west-1', GH_CONFIG_DIR: '/tmp/gh', GIT_ASKPASS: '/tmp/askpass',
    GIT_CONFIG_KEY_1: 'core.hooksPath', GIT_CONFIG_VALUE_1: '/dev/null',
    HTTPS_PROXY: 'https://proxy.example.test' });
  expect(env).not.toHaveProperty('USER_SECRET');
  expect(agentEnvironment('codex', source)).not.toHaveProperty('AWS_BEARER_TOKEN_BEDROCK');
});

it('passes provider-specific proxy routing only to Cursor and Grok children', () => {
  const cursorProxy = 'https://proxy.test/v1/house/cursor/runs/run-1';
  const source = {
    CURSOR_API_KEY: 'cursor-key',
    CURSOR_API_ENDPOINT: cursorProxy,
    CURSOR_API_BASE_URL: cursorProxy,
    XAI_API_KEY: 'xai-key',
    GROK_XAI_API_BASE_URL: 'https://proxy.test/v1/house/xai/runs/run-1',
    GROK_HOME: '/tmp/grok-house-run-1',
  };
  const cursorNames = ['CURSOR_API_KEY', 'CURSOR_API_ENDPOINT', 'CURSOR_API_BASE_URL'];
  const grokNames = ['XAI_API_KEY', 'GROK_XAI_API_BASE_URL', 'GROK_HOME'];
  const providerClis = ['claude', 'codex', 'gemini', 'cursor-agent', 'droid', 'grok',
    'opencode', 'aider', 'goose', 'pi', 'deepagents'];
  expect([...providerEnvironmentCliNames()].sort()).toEqual([...providerClis].sort());
  expect(agentEnvironment('cursor-agent', source)).toMatchObject({
    CURSOR_API_KEY: source.CURSOR_API_KEY,
    CURSOR_API_ENDPOINT: source.CURSOR_API_ENDPOINT,
    CURSOR_API_BASE_URL: source.CURSOR_API_BASE_URL,
  });
  expect(agentEnvironment('grok', source)).toMatchObject({
    XAI_API_KEY: source.XAI_API_KEY,
    GROK_XAI_API_BASE_URL: source.GROK_XAI_API_BASE_URL,
    GROK_HOME: source.GROK_HOME,
  });
  for (const name of grokNames) expect(agentEnvironment('cursor-agent', source)).not.toHaveProperty(name);
  for (const name of cursorNames) expect(agentEnvironment('grok', source)).not.toHaveProperty(name);
  for (const cli of [...providerClis.filter(name => !['cursor-agent', 'grok'].includes(name)), '/custom/cli']) {
    for (const name of [...cursorNames, ...grokNames]) expect(agentEnvironment(cli, source)).not.toHaveProperty(name);
  }
});

async function request(path: string, value: object) {
  const socket = createConnection(path);
  await once(socket, 'connect');
  socket.end(JSON.stringify(value));
  let text = '';
  for await (const chunk of socket) text += chunk;
  return JSON.parse(text);
}
it('rejects missing, incorrect, and another session token before invoking journal operations', async () => {
  const invoke = vi.fn(async () => ({ seq: 1 }));
  const first = await openCommunicationTools(invoke);
  const second = await openCommunicationTools(invoke);
  const operation = { operation: 'complete', values: ['forged completion'] };
  try {
    for (const token of [undefined, 'wrong', second.token]) {
      expect(await request(first.path, { ...operation, token })).toEqual({ error: 'Unauthorized communication session' });
    }
    expect(invoke).not.toHaveBeenCalled();
    expect(await request(first.path, { ...operation, token: first.token })).toEqual({ result: { seq: 1 } });
    expect(invoke).toHaveBeenCalledWith(operation);
  } finally { await first.close(); await second.close(); }
});
