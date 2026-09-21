import { createConnection } from 'node:net';
import { once } from 'node:events';
import { it, expect, vi } from 'vitest';
import { CommunicationSession } from '../src/communication/session.js';
import { createProjection } from '../src/communication/projection.js';
import { openCommunicationTools } from '../src/communication/tools.js';
import { agentEnvironment, brokerEnvironment } from '../src/communication/environment.js';
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
