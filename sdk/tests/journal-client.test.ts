import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { rmSync } from 'node:fs';
import { JournalClient } from '../src/journal-client.js';
import { compileYaml, toKernelSpec } from '../src/compile.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import type { FlowSpec, KernelRunSpec } from '../src/spec.js';

// Protocol-v0 client tests over a real unix socket. The transport is real
// (newline-delimited JSON frames over `node:net`), but the server side is a
// minimal loopback test double — NOT the kernel. What these tests prove is
// the client: framing, request/response correlation, event demultiplexing,
// and fail-closed behavior on errors and connection drops. Kernel semantics
// are proven in `kernel/relayflowd/` (unit + crash-injection tests).

function sockPath(): string {
  return join(tmpdir(), `rf-${randomUUID().slice(0, 8)}.sock`);
}

const HELLO_FLOW: FlowSpec = {
  version: '0.1.0',
  name: 'client-roundtrip',
  steps: [{ id: 'greet', type: 'deterministic', command: 'echo hi' }],
};
const HELLO_SPEC: KernelRunSpec = toKernelSpec(HELLO_FLOW);

interface FrameCtx {
  id: string;
  socket: Socket;
  send: (obj: unknown) => void;
}

function startLoopback(path: string, handlers: {
  hello?: (ctx: FrameCtx) => void;
  'run.start'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'run.resume'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'run.get'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'run.watch'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'worker.attach'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'step.heartbeat'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'effect.record'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'step.complete'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'event.emit'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'journal.read'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'stream.append'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
  'stream.read'?: (ctx: FrameCtx, params: Record<string, unknown>) => void;
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
          case 'run.resume':
            handlers['run.resume']?.(ctx, req.params);
            break;
          case 'run.get':
            handlers['run.get']?.(ctx, req.params);
            break;
          case 'run.watch':
            handlers['run.watch']?.(ctx, req.params);
            break;
          case 'worker.attach':
            handlers['worker.attach']?.(ctx, req.params);
            break;
          case 'step.heartbeat':
            handlers['step.heartbeat']?.(ctx, req.params);
            break;
          case 'effect.record':
            handlers['effect.record']?.(ctx, req.params);
            break;
          case 'step.complete':
            handlers['step.complete']?.(ctx, req.params);
            break;
          case 'event.emit':
            handlers['event.emit']?.(ctx, req.params);
            break;
          case 'journal.read':
            handlers['journal.read']?.(ctx, req.params);
            break;
          case 'stream.append':
            handlers['stream.append']?.(ctx, req.params);
            break;
          case 'stream.read':
            handlers['stream.read']?.(ctx, req.params);
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

let lastStartedSpec: Record<string, unknown> | null = null;

// A faithful mini-mirror of `RunSpec::parse` (kernel/relayflowd-core/src/spec.rs):
// snake_case keys only, per-type step key sets, flat v0 verification. Returns
// an error message, or null when the spec is in the kernel dialect.
function kernelDialectError(spec: unknown): string | null {
  if (typeof spec !== 'object' || spec === null) return 'spec: expected an object';
  const rootAllowed = new Set(['version', 'name', 'description', 'steps', 'budget']);
  for (const key of Object.keys(spec)) {
    if (!rootAllowed.has(key)) return `unknown field "${key}" at spec`;
  }
  const steps = (spec as { steps?: unknown }).steps;
  if (!Array.isArray(steps)) return 'steps: expected an array';
  const common = ['id', 'type', 'depends_on', 'max_iterations', 'retry', 'verification'];
  const byType: Record<string, string[]> = {
    deterministic: ['command', 'timeout_ms'],
    llm: ['prompt', 'model'],
    agent: ['instruction', 'recovery_mode', 'surfaces', 'permissions'],
  };
  for (const [index, step] of steps.entries()) {
    const st = step as Record<string, unknown>;
    const kindFields = byType[st.type as string];
    if (kindFields === undefined) return `steps[${index}]: unknown type`;
    const allowed = new Set([...common, ...kindFields]);
    for (const key of Object.keys(st)) {
      if (!allowed.has(key)) return `unknown field "${key}" at steps[${index}]`;
    }
    if (st.verification !== undefined) {
      const gateAllowed = new Set(['output_contains', 'json_schema']);
      for (const key of Object.keys(st.verification as Record<string, unknown>)) {
        if (!gateAllowed.has(key)) return `unknown field "${key}" at steps[${index}].verification`;
      }
    }
  }
  return null;
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
        // Mirror the kernel's fail-closed `RunSpec::parse`: only the kernel
        // dialect is accepted — an authoring-shape spec (camelCase keys,
        // tagged verification) is rejected, exactly like the real server.
        const dialectError = kernelDialectError(params.spec);
        if (dialectError !== null) {
          ctx.send({ id: ctx.id, ok: false, error: { code: 'invalid_spec', message: dialectError } });
          return;
        }
        lastStartedSpec = params.spec as Record<string, unknown>;
        const spec = params.spec as { name?: string };
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
      'run.resume': (ctx, params) => {
        sendResult(ctx, { run_id: params.run_id, status: 'completed', completed_steps: 2 });
      },
      'run.get': (ctx) => {
        sendResult(ctx, { status: 'running', steps: [], budget: { tokens_in: 0, tokens_out: 0, dollars: '0' } });
      },
      'run.watch': (ctx, params) => {
        sendResult(ctx, undefined);
        ctx.send({ event: 'entry', data: { run_id: params.run_id, seq: 2 } });
      },
      'worker.attach': (ctx, params) => {
        sendResult(ctx, undefined);
        ctx.send({
          event: 'step.dispatch',
          data: {
            run_id: 'run-01', step_id: 'model', attempt: 1, step_type: 'llm',
            spec: {}, lease_id: 'lease-1', idempotency_key: 'key-1', pins: {},
            lease_deadline_ms: 1000, worker_id: params.worker_id,
          },
        });
      },
      'step.heartbeat': (ctx, params) => {
        sendResult(ctx, { lease_deadline_ms: params.lease_id === 'lease-1' ? 2000 : -1 });
      },
      'effect.record': (ctx, params) => {
        sendResult(ctx, { deduped: params.surface_path === '/github/pull/1' });
      },
      'step.complete': (ctx, params) => {
        sendResult(ctx, params.completionReason === 'success' ? undefined : null);
      },
      'event.emit': (ctx, params) => {
        sendResult(ctx, { matched: params.event_key === 'approved' ? 1 : 0 });
      },
      'stream.read': (ctx, params) => {
        sendResult(ctx, { messages: [{ offset: params.from_offset }], next_offset: 8 });
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

  it('round-trips a spec straight from compileYaml through run.start in the kernel dialect', async () => {
    // Authoring sugar the kernel's RunSpec::parse rejects verbatim:
    // maxIterations, dependsOn, tagged verification. The caller must compile
    // via toKernelSpec before invoking the kernel-dialect journal boundary.
    const flow = compileYaml(`
version: '0.1.0'
name: ladder-roundtrip
steps:
  - id: fetch
    type: deterministic
    command: echo hi
    maxIterations: 3
  - id: check
    type: deterministic
    command: grep hi out.txt
    dependsOn: [fetch]
    verification:
      type: output_contains
      value: hi
`);
    client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await client.hello('sdk-test');
    lastStartedSpec = null;
    const res = await client.runStart(toKernelSpec(flow));
    expect(res.run_id).toBe('run-01');
    // What crossed the wire is the kernel dialect, not the authoring shape.
    const wired = lastStartedSpec as Record<string, unknown>;
    expect(wired).not.toBeNull();
    const check = (wired.steps as Record<string, unknown>[])[1];
    expect(check.depends_on).toEqual(['fetch']);
    expect(check.max_iterations).toBe(1);
    expect(check.verification).toEqual({ output_contains: 'hi' });
    expect(check.dependsOn).toBeUndefined();
    expect((wired.steps as Record<string, unknown>[])[0].max_iterations).toBe(3);
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

  it('wires every out-of-band worker verb and receives dispatch events', async () => {
    client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    const dispatch = new Promise<Record<string, unknown>>((resolve) => {
      client.once('step.dispatch', (data) => resolve(data as Record<string, unknown>));
    });
    await client.workerAttach('worker-1', ['llm']);
    const lease = await dispatch;
    expect(lease.lease_id).toBe('lease-1');
    expect(lease.idempotency_key).toBe('key-1');
    const heartbeat = await client.stepHeartbeat('run-01', 'model', 1, 'lease-1');
    expect(heartbeat.lease_deadline_ms).toBe(2000);
    const effect = await client.effectRecord(
      'run-01', 'model', 1, 'key-1', '/github/pull/1', 'rev-a', 'rev-b',
    );
    expect(effect.deduped).toBe(true);
    await client.stepComplete('run-01', 'model', 1, 'key-1', 'success', {
      output: { answer: 4 },
      usage: { tokens_in: 6, tokens_out: 3, dollars: '0.001' },
    });
  });

  it('wires run watch, resume/get, events, and replayable stream reads', async () => {
    client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    const entry = new Promise<Record<string, unknown>>((resolve) => {
      client.once('entry', (data) => resolve(data as Record<string, unknown>));
    });
    await client.runWatch('run-01');
    expect((await entry).seq).toBe(2);
    expect((await client.runResume('run-01')).run_id).toBe('run-01');
    expect((await client.runGet('run-01')).status).toBe('running');
    expect((await client.eventEmit('run-01', 'approved', { ok: true })).matched).toBe(1);
    const read = await client.streamRead('run-01', 'results', 7, 10);
    expect(read.next_offset).toBe(8);
    expect(read.messages).toEqual([{ offset: 7 }]);
  });

  it('fails closed when the server returns an error', async () => {
    const errorPath = sockPath();
    const errorServer = startLoopback(errorPath, {
      'run.resume': (ctx) => {
        ctx.send({ id: ctx.id, ok: false, error: { code: 'journal_write_failed', message: 'disk full' } });
      },
    });
    try {
      client = new JournalClient(errorPath, { requestTimeoutMs: 2000 });
      await client.connect();
      await expect(client.runResume('run-01')).rejects.toThrow(/journal_write_failed/);
    } finally {
      client?.close();
      await new Promise<void>((r) => errorServer.close(() => r()));
      rmSync(errorPath, { force: true });
    }
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
