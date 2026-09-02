import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { Server } from 'node:net';
import { rmSync } from 'node:fs';
import { JournalClient, JournalProtocolError } from '../src/journal-client.js';
import { compileYaml, toKernelSpec } from '../src/compile.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';
import {
  HELLO_SPEC,
  kernelDialectError,
  sendOk,
  sendResult,
  sockPath,
  startLoopback,
  type FrameCtx,
} from './journal-client-loopback.js';

// Protocol-v0 client tests over a real unix socket. The transport is real
// (newline-delimited JSON frames over `node:net`), but the server side is a
// minimal loopback test double — NOT the kernel. What these tests prove is
// the client: framing, request/response correlation, event demultiplexing,
// and fail-closed behavior on errors and connection drops. Kernel semantics
// are proven in `kernel/relayflowd/` (unit + crash-injection tests).

let lastStartedSpec: Record<string, unknown> | null = null;

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
      'run.cancel': (ctx, params) => {
        sendResult(ctx, {
          run_id: params.run_id,
          status: 'failed',
          completion_reason: 'canceled',
          completed_steps: 1,
        });
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

  it('cancels a run through the typed lifecycle surface', async () => {
    client = new JournalClient(path, { requestTimeoutMs: 2000 });
    await client.connect();
    await expect(client.runCancel('run-01')).resolves.toEqual({
      run_id: 'run-01',
      status: 'failed',
      completion_reason: 'canceled',
      completed_steps: 1,
    });
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
      const rejected = client.runResume('run-01');
      await expect(rejected).rejects.toBeInstanceOf(JournalProtocolError);
      await expect(rejected).rejects.toMatchObject({ code: 'journal_write_failed' });
    } finally {
      client?.close();
      await new Promise<void>((r) => errorServer.close(() => r()));
      rmSync(errorPath, { force: true });
    }
  });

  it('does not apply the bounded request timeout to run lifecycle requests', async () => {
    const lifecyclePath = sockPath();
    const lifecycleServer = startLoopback(lifecyclePath, {
      'run.start': (ctx) => {
        setTimeout(() => sendResult(ctx, {
          run_id: 'slow-run',
          status: 'completed',
          completion_reason: 'success',
          completed_steps: 1,
        }), 50);
      },
    });
    try {
      client = new JournalClient(lifecyclePath, { requestTimeoutMs: 10 });
      await client.connect();
      await expect(client.runStart(HELLO_SPEC)).resolves.toMatchObject({
        run_id: 'slow-run',
        status: 'completed',
      });
    } finally {
      client?.close();
      await new Promise<void>((r) => lifecycleServer.close(() => r()));
      rmSync(lifecyclePath, { force: true });
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

/// Appendix A rule 5 at the SDK boundary. The double below is a faithful
/// mini-mirror of the kernel's election table (`kernel/relayflowd-journal`):
/// an election only suppresses a later attempt once it has been *confirmed*,
/// and an unconfirmed election is reclaimed by the next attempt. What is being
/// proven here is the client: that performing an effect cannot leave the
/// election and the provider call separated.
describe('JournalClient: an effect election is atomic with its provider call', () => {
  interface Election {
    attempt: number;
    confirmed: boolean;
  }

  function startElectionServer(path: string, elections: Map<string, Election>): Server {
    return startLoopback(path, {
      'effect.record': (ctx, params) => {
        const key = `${params.step_id}|${params.idempotency_key}|${params.surface_path}`;
        const attempt = params.attempt as number;
        const held = elections.get(key);
        const deduped = held !== undefined && (held.confirmed || held.attempt === attempt);
        if (!deduped) elections.set(key, { attempt, confirmed: false });
        sendResult(ctx, { deduped });
      },
      'effect.confirm': (ctx, params) => {
        const key = `${params.step_id}|${params.idempotency_key}|${params.surface_path}`;
        const held = elections.get(key);
        if (held === undefined || held.attempt !== params.attempt) {
          ctx.send({
            id: ctx.id,
            ok: false,
            error: { code: 'internal', message: 'does not hold the election' },
          });
          return;
        }
        elections.set(key, { attempt: held.attempt, confirmed: true });
        sendResult(ctx, { confirmed: params.surface_path });
      },
    });
  }

  const effect = (attempt: number) => ({
    runId: 'run-01',
    stepId: 'agent',
    attempt,
    idempotencyKey: 'stable',
    surfacePath: '/provider/item',
    revisionBefore: 'rev-a',
    revisionAfter: 'rev-b',
  });

  it('performs the effect exactly once when an attempt dies between electing and calling', async () => {
    const path = sockPath();
    const elections = new Map<string, Election>();
    const server = startElectionServer(path, elections);
    const clients: JournalClient[] = [];
    const attempt = async (n: number, perform: () => Promise<void>): Promise<boolean> => {
      const client = new JournalClient(path, { requestTimeoutMs: 2000 });
      clients.push(client);
      await client.connect();
      return client.performEffect(effect(n), perform);
    };
    let providerCalls = 0;
    try {
      // Attempt 1 wins the election and dies before the provider call — the
      // crash window a one-phase record leaves open.
      await expect(
        attempt(1, async () => {
          throw new Error('SIGKILL between election and provider call');
        }),
      ).rejects.toThrow();
      expect(providerCalls).toBe(0);

      // Attempt 2 reclaims the election nobody confirmed and performs it.
      const performed = await attempt(2, async () => {
        providerCalls += 1;
      });
      expect(performed).toBe(true);
      expect(providerCalls).toBe(1);

      // Attempt 3 is suppressed by the now-confirmed election: exactly once.
      const again = await attempt(3, async () => {
        providerCalls += 1;
      });
      expect(again).toBe(false);
      expect(providerCalls).toBe(1);
    } finally {
      for (const client of clients) client.close();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(path, { force: true });
    }
  });

  it('leaves an unconfirmed election reclaimable rather than suppressing the effect forever', async () => {
    const path = sockPath();
    const elections = new Map<string, Election>();
    const server = startElectionServer(path, elections);
    let client: JournalClient | undefined;
    try {
      client = new JournalClient(path, { requestTimeoutMs: 2000 });
      await client.connect();
      // A bare election — the shape a caller reaching past `performEffect`
      // would leave behind — must not read as done to the next attempt.
      const elected = await client.effectRecord(
        'run-01', 'agent', 1, 'stable', '/provider/item', 'rev-a', 'rev-b',
      );
      expect(elected.deduped).toBe(false);
      const next = await client.effectRecord(
        'run-01', 'agent', 2, 'stable', '/provider/item', 'rev-a', 'rev-b',
      );
      expect(next.deduped).toBe(false);
      // Only a confirmation closes it.
      await client.effectConfirm('run-01', 'agent', 2, 'stable', '/provider/item');
      const after = await client.effectRecord(
        'run-01', 'agent', 3, 'stable', '/provider/item', 'rev-a', 'rev-b',
      );
      expect(after.deduped).toBe(true);
    } finally {
      client?.close();
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(path, { force: true });
    }
  });
});
