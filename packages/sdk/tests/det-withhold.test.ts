import { rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';
import { HELLO_SPEC, sendResult, sockPath, startLoopback } from './journal-client-loopback.js';

// `relayflowd serve --det-withhold` advertises names in hello.det_withheld.
// A current client leaves their VALUES out of the env it sends on run.start
// and run.resume (the kernel strips them at spawn regardless). Asserted on the
// raw bytes the real JournalClient writes to the socket.
const WITHHELD: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-fixtureAgentOnly-5Tz8Lm2Q',
  RELAY_AGENT_TOKEN: 'fixture-relay-agent-token-3Kd1',
  HOUSE_PROXY_CREDENTIAL: 'fixture-house-proxy-credential-8Vn3',
};
const ORDINARY = { DELIVERED_SECRET: 'delivered-fixture-value-81Jx', GH_CONFIG_DIR: '/fixture/gh-config' };

async function capture(hello: Record<string, unknown>) {
  const path = sockPath();
  const bytes: Buffer[] = [];
  const params: Record<string, unknown>[] = [];
  const server = startLoopback(path, {
    hello: ctx => sendResult(ctx, { protocol: 0, server: 'relayflowd', ...hello }),
    'run.start': (ctx, p) => { params.push(p); sendResult(ctx, { run_id: 'run-01', status: 'completed' }); },
    'run.resume': (ctx, p) => { params.push(p); sendResult(ctx, { run_id: 'run-01', status: 'completed' }); },
  });
  server.on('connection', (socket: Socket) => socket.on('data', chunk => bytes.push(chunk)));
  const saved = { ...process.env };
  Object.assign(process.env, WITHHELD, ORDINARY);
  const client = new JournalClient(path);
  try {
    await client.connect();
    await client.hello('det-withhold');
    await client.runStart(HELLO_SPEC);
    await client.runResume('run-01');
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(path, { force: true });
  }
  return { wire: Buffer.concat(bytes).toString('utf8'), params };
}

it('omits every advertised withheld value from run.start and run.resume', async () => {
  const { wire, params } = await capture({ features: ['step_env'], det_withheld: Object.keys(WITHHELD) });
  expect(params.map(p => Object.keys(p).includes('env'))).toEqual([true, true]);
  for (const [name, value] of Object.entries(WITHHELD)) {
    expect(wire, `${name}'s value crossed the wire`).not.toContain(value);
    for (const sent of params) expect(sent['env'] as Record<string, string>).not.toHaveProperty(name);
  }
  for (const sent of params) {
    for (const [name, value] of Object.entries(ORDINARY)) expect((sent['env'] as Record<string, string>)[name]).toBe(value);
  }
});

it('sends the env unchanged to a daemon that withholds nothing', async () => {
  const { params } = await capture({ features: ['step_env'] });
  for (const sent of params) {
    for (const [name, value] of Object.entries(WITHHELD)) expect((sent['env'] as Record<string, string>)[name]).toBe(value);
  }
});
