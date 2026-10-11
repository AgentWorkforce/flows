import { rmSync } from 'node:fs';
import type { Socket } from 'node:net';
import { expect, it } from 'vitest';
import { JournalClient } from '../src/journal-client.js';
import { HELLO_SPEC, sendResult, sockPath, startLoopback } from './journal-client-loopback.js';

/**
 * DESIGN FIXTURE (docs/proposals/trusted-det-step-credentials.md §4.5, §6).
 *
 * A COMPLIANT SDK omits every name the daemon lists in `hello.det_withheld`
 * from the env it sends on run.start AND run.resume, so no withheld agent
 * value and no bound det credential is in the bytes it writes. The kernel
 * strip stays authoritative for nonconforming clients
 * (kernel/relayflowd/tests/det_credentials_design/leaks.rs).
 *
 * Skipped unless FLOWS_DESIGN_FIXTURES=1: the interface is absent on main, so
 * forcing it shows that absence (today's stepEnv() sends all of process.env).
 */
const DESIGN = process.env['FLOWS_DESIGN_FIXTURES'] !== '1';

const WITHHELD: Record<string, string> = {
  ANTHROPIC_API_KEY: 'sk-ant-fixtureAgentOnly-5Tz8Lm2Q',
  OPENAI_API_KEY: 'sk-fixtureAgentOnly-openai-3Kd1Vb7',
  CLAUDE_CODE_OAUTH_TOKEN: 'fixture-oauth-agent-only-9HqW4e',
  XAI_API_KEY: 'xai-fixtureHousePickup-2Rw7Kp4',
  HOUSE_PROXY_CREDENTIAL: 'fixture-house-proxy-credential-8Vn3',
  // A bound name the daemon reserves: the caller's own copy is withheld too.
  GH_TOKEN: 'caller-copy-of-a-bound-name-4Qe1',
};

it.skipIf(DESIGN)('a compliant SDK keeps every withheld value off the run.start and run.resume wire', async () => {
  const path = sockPath();
  const bytes: Buffer[] = [];
  const params: Record<string, unknown>[] = [];
  const server = startLoopback(path, {
    hello: ctx => sendResult(ctx, {
      protocol: 0, server: 'relayflowd', features: ['step_env', 'det_credentials'],
      det_withheld: Object.keys(WITHHELD),
    }),
    'run.start': (ctx, p) => { params.push(p); sendResult(ctx, { run_id: 'run-01', status: 'completed' }); },
    'run.resume': (ctx, p) => { params.push(p); sendResult(ctx, { run_id: 'run-01', status: 'completed' }); },
  });
  server.on('connection', (socket: Socket) => socket.on('data', chunk => bytes.push(chunk)));
  const saved = { ...process.env };
  Object.assign(process.env, WITHHELD, { DELIVERED_SECRET: 'delivered-fixture-value-81Jx' });
  const client = new JournalClient(path);
  try {
    await client.connect();
    await client.hello('det-credentials-design');
    await client.runStart(HELLO_SPEC);
    await client.runResume('run-01');
    expect(params).toHaveLength(2);
    const wire = Buffer.concat(bytes).toString('utf8');
    for (const [name, value] of Object.entries(WITHHELD)) {
      expect(wire, `${name}'s value crossed the wire`).not.toContain(value);
      for (const sent of params) expect(sent['env'] as Record<string, string>).not.toHaveProperty(name);
    }
    // Ordinary names keep their per-run env path.
    for (const sent of params) {
      expect((sent['env'] as Record<string, string>)['DELIVERED_SECRET']).toBe('delivered-fixture-value-81Jx');
    }
  } finally {
    for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key];
    Object.assign(process.env, saved);
    client.close();
    await new Promise<void>(resolve => server.close(() => resolve()));
    rmSync(path, { force: true });
  }
});
