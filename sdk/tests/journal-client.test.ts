import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { JournalClient } from '../src/journal-client.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import type { FlowSpec } from '../src/spec.js';

// Protocol-v0 client tests over a real unix socket. The transport is real
// (newline-delimited JSON frames over `node:net`), but the server side is a
// minimal loopback test double — NOT the kernel. What these tests prove is
// the client: framing, request/response correlation, event demultiplexing,
// and fail-closed behavior on errors and connection drops. Kernel semantics
// are proven in `kernel/relayflowd/` (unit + crash-injection tests).

function sockPath(): string {
  return join(tmpdir(), `rf-${randomUUID().slice(0, 8)}.sock`);
}

const HELLO_SPEC: FlowSpec = {
  version: '0.1.0',
  name: 'client-roundtrip',
  steps: [{ id: 'greet', type: 'deterministic', command: 'echo hi' }],
};

interface FrameCtx {
  id: string;
  socket: Socket;
  send: (obj: unknown) => void;
}

function startLoopback(path: string, handlers: {
  hello?: (ctx: FrameCtx) => void;
  'run.start'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'journal.read'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'stream.append'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
}): Server {
  const server = createServer((socket) => {
    let buffer = '';
    const send = (obj: unknown): void => {
      socket.write(JSON.stringify(obj) + '\n');
    };
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length === 0) continue;
        const req = JSON.parse(line) as { id: string; verb: string; params: Record<string, unknown> };
        const ctx: FrameCtx = { id: req.id, socket, send };
        switch (req.verb) {
          case 'hello':
            handlers.hello?.(ctx);
            break;
          case 'run.start':
            handlers['run.start']?.(ctx, req.params);
            break;
          case 'journal.read':
            handlers['journal.read']?.(ctx, req.params);
            break;
          case 'stream.append':
            handlers['stream.append']?.(ctx, req.params);
            break;
          default:
            send({ id: req.id, ok: false, error: { code: 'unknown_verb', message: req.verb } });
        }
      }
    });
  });
  server.listen(path);
  return server;
}

describe('JournalClient: protocol v0 over unix socket', () => {
  let path: string;
  let server: Server;

  beforeAll(() => {
    path = sockPath();
    server = startLoopback(path, {
      hello: (ctx) => {
        sendOk(ctx);
      },
      'run.start': (ctx, params) => {
        const spec = params.spec as FlowSpec;
        // Kernel validates spec (zero-agent legal) and appends run.spawned.
        sendResult(ctx, { run_id: 'run-01' });
        // Server-pushed entry event for run.watch subscribers would follow.
        ctx.send({ event: 'run.spawned', data: { run_id: 'run-01', name: spec.name } });
      },
      'journal.read': (ctx) => {
        sendResult(ctx, { entries: [{ seq: 1, entry_type: 'run.spawned', step_id: null, attempt: null, at_ms: 0, payload: {} }] });
      },
      'stream.append': (ctx, params) => {
        // The client sends {run_id, stream, message}; echo an offset only for
        // the params it actually transmitted, so the test pins the wire shape.
        const ok = params.run_id === 'run-01' && params.stream === 'results'
          && (params.message as { hello?: string })?.hello === 'world';
        sendResult(ctx, { offset: ok ? 7 : -1 });
      },
    });
  });

  afterAll(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(path, { force: true });
  });

  let client: JournalClient;

  afterEach(() => client?.close());

  it('handshakes with the matching protocol version', async () => {
    client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    const res = await client.hello('sdk-test');
    expect(res.protocol).toBe(PROTOCOL_VERSION);
    expect(res.server).toBeDefined();
  });

  it('starts a run and receives the run_id (zero-agent spec is legal)', async () => {
    client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('sdk-test');
    const res = await client.runStart(HELLO_SPEC);
    expect(res.run_id).toBe('run-01');
  });

  it('demultiplexes server-pushed events', async () => {
    client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('sdk-test');
    const seen = new Promise<void>((resolve) => {
      client.once('run.spawned', (data) => {
        expect((data as { run_id: string }).run_id).toBe('run-01');
        resolve();
      });
    });
    await client.runStart(HELLO_SPEC);
    await seen;
  });

  it('reads the journal and streams', async () => {
    client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('sdk-test');
    const jr = await client.journalRead('run-01', 1);
    expect(jr.entries).toHaveLength(1);
    expect((jr.entries[0] as { entry_type: string }).entry_type).toBe('run.spawned');
    const sa = await client.streamAppend('run-01', 'results', { hello: 'world' });
    expect(sa.offset).toBe(7); // loopback echoes 7 only if the wire params matched
  });

  it('fails closed when the server returns an error', async () => {
    // Use a verb the loopback does not implement -> unknown_verb.
    client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('sdk-test');
    await expect(client.runResume('run-01')).rejects.toThrow(/unknown_verb/);
  });

  it('fails closed on connection drop (pending requests reject)', async () => {
    const dropPath = sockPath();
    const dropServer = startLoopback(dropPath, {
      hello: (ctx) => {
        // Never respond; then destroy the socket to simulate kill -9.
        ctx.socket.destroy();
      },
    });
    try {
      const c = new JournalClient(dropPath, { requestTimeoutMs: 5000 });
      await c.connect();
      await expect(c.hello('sdk-test')).rejects.toThrow(/connection closed|connect failed/);
    } finally {
      await new Promise<void>((r) => dropServer.close(() => r()));
      rmSync(dropPath, { force: true });
    }
  });

  it('rejects requests when not connected', async () => {
    client = new JournalClient(path);
    await expect(client.hello('x')).rejects.toThrow(/not connected/);
  });
});

// --- helpers ---

function sendOk(ctx: FrameCtx): void {
  ctx.send({ id: ctx.id, ok: true, result: { protocol: PROTOCOL_VERSION, server: 'relayflowd-test' } });
}

function sendResult(ctx: FrameCtx, result: unknown): void {
  ctx.send({ id: ctx.id, ok: true, result });
}
