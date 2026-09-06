/**
 * Tests for `flows hn-monitor start`.
 *
 * argv-parsing tests use runCli() so the parser is exercised through
 * the top-level entry point. Loop tests call runHnMonitor() directly
 * with plain function-parameter injection (`connectClient`,
 * `attachWorker`, `fetcher`) — no test-only interface leaks into
 * production types.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { runCli, type CliIo } from '../src/cli.js';
import { runHnMonitor, type HnMonitorClient } from '../src/cli/hn-monitor.js';
import { HnTransientFetchError } from '../src/hn-poller.js';
import { JournalProtocolError } from '../src/journal-client.js';
import { PROTOCOL_VERSION } from '../src/protocol.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) {
    try { rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'cli-hn-mon-'));
  dirs.push(d);
  return d;
}

function ioBuf(): CliIo & { stdout_lines: string[]; stderr_lines: string[] } {
  const stdout_lines: string[] = [];
  const stderr_lines: string[] = [];
  return {
    stdout(line) { stdout_lines.push(line); },
    stderr(line) { stderr_lines.push(line); },
    get stdout_lines() { return stdout_lines; },
    get stderr_lines() { return stderr_lines; },
  } as any;
}

function specFile(): string {
  const dir = tmp();
  const path = join(dir, 's.json');
  writeFileSync(path, JSON.stringify({ name: 'hn-monitor', version: '0.1.0' }));
  return path;
}

function goodClient(): HnMonitorClient & {
  submissions: Array<{ spec: unknown; event: unknown }>;
  closed: boolean;
} {
  const submissions: Array<{ spec: unknown; event: unknown }> = [];
  let closed = false;
  const c: HnMonitorClient = {
    async hello() { return { protocol: PROTOCOL_VERSION, server: 'test-hn-monitor' }; },
    async eventSubmit(spec, event) {
      submissions.push({ spec, event });
      return { matched: true, deduped: false };
    },
    close() { closed = true; },
  };
  return Object.defineProperties(c, {
    submissions: { get: () => submissions },
    closed: { get: () => closed },
  }) as HnMonitorClient & { submissions: typeof submissions; closed: boolean };
}

describe('flows hn-monitor start — argv parsing', () => {
  it('accepts a minimum invocation (spec positional only) — parse succeeds, connect fails positively', async () => {
    // Parse must succeed (positive assertion) and downstream must reach
    // the connect layer and emit the connect-failure line. A parser
    // regression that returned exit 1 without ever attempting to
    // connect would previously have passed the "code === 1 and no
    // Usage:" check — this assertion pins the actual control flow.
    const io = ioBuf();
    const dir = tmp();
    const specPath = join(dir, 's.json');
    writeFileSync(specPath, JSON.stringify({ name: 'hn-monitor' }));
    const code = await runCli(['hn-monitor', 'start', specPath], io);
    expect(code).toBe(1);
    expect(io.stderr_lines.some((l) => l.includes('Usage:'))).toBe(false);
    expect(io.stderr_lines.some((l) => l.includes('cannot connect to relayflowd'))).toBe(true);
  });

  it('rejects unknown subcommand', async () => {
    const io = ioBuf();
    const code = await runCli(['hn-monitor', 'noodle'], io);
    expect(code).toBe(2);
    expect(io.stderr_lines.some((l) => l.includes('flows hn-monitor start'))).toBe(true);
  });

  it('rejects negative --poll-interval-ms', async () => {
    const io = ioBuf();
    const code = await runCli(['hn-monitor', 'start', '--poll-interval-ms', '-5', 's.json'], io);
    expect(code).toBe(2);
  });

  it('rejects non-numeric --poll-interval-ms', async () => {
    const io = ioBuf();
    const code = await runCli(['hn-monitor', 'start', '--poll-interval-ms', 'abc', 's.json'], io);
    expect(code).toBe(2);
  });

  it('rejects duplicate --data-dir', async () => {
    const io = ioBuf();
    const code = await runCli(['hn-monitor', 'start', '--data-dir', 'a', '--data-dir', 'b', 's.json'], io);
    expect(code).toBe(2);
  });
});

describe('runHnMonitor — inline primitive composition', () => {
  it('returns 1 when the spec file does not exist (fail-closed)', async () => {
    const io = ioBuf();
    const code = await runHnMonitor({
      dataDir: '/nonexistent',
      specPath: '/nonexistent/spec.json',
    }, io);
    expect(code).toBe(1);
    expect(io.stderr_lines.some((l) => l.includes('cannot read spec'))).toBe(true);
  });

  it('returns 1 when the connect callback throws (fail-closed on connect)', async () => {
    const io = ioBuf();
    const code = await runHnMonitor({
      dataDir: tmp(),
      specPath: specFile(),
      connectClient: async () => { throw new Error('ENOENT'); },
      attachWorker: async (_c, _onErr) => ({ close: async () => {} }),
    }, io);
    expect(code).toBe(1);
    expect(io.stderr_lines.some((l) => l.includes('cannot connect'))).toBe(true);
  });

  it('returns 1 when the attach callback throws (fail-closed on attach) — closes the client', async () => {
    const io = ioBuf();
    const client = goodClient();
    const code = await runHnMonitor({
      dataDir: tmp(),
      specPath: specFile(),
      connectClient: async () => client,
      attachWorker: async () => { throw new Error('worker_attach_denied'); },
    }, io);
    expect(code).toBe(1);
    expect(io.stderr_lines.some((l) => l.includes('worker attach failed'))).toBe(true);
    expect(io.stderr_lines.some((l) => l.includes('worker_attach_denied'))).toBe(true);
    // Client MUST be closed on attach failure or the socket leaks —
    // regression pin for the finally-block ordering.
    expect(client.closed).toBe(true);
  });

  it('exits cleanly (exit 0) when maxPolls === 0 — attach, drain, exit; NO poll dispatched', async () => {
    const io = ioBuf();
    const client = goodClient();
    let fetches = 0;
    const code = await runHnMonitor({
      dataDir: tmp(),
      specPath: specFile(),
      pollIntervalMs: 1,
      maxPolls: 0,
      connectClient: async () => client,
      attachWorker: async () => ({ close: async () => {} }),
      fetcher: async () => { fetches++; return '[1]'; },
    }, io);
    expect(code).toBe(0);
    expect(fetches).toBe(0);
    expect(client.submissions).toHaveLength(0);
    expect(client.closed).toBe(true);
  });

  it('runs the loop end-to-end (submits one event per story per tick, cleanly exits on maxPolls)', async () => {
    const io = ioBuf();
    const client = goodClient();
    const workerCloses: number[] = [];
    const code = await runHnMonitor({
      dataDir: tmp(),
      specPath: specFile(),
      pollIntervalMs: 1,
      maxPolls: 2,
      connectClient: async () => client,
      attachWorker: async (_c, _onErr) => ({ close: async () => { workerCloses.push(Date.now()); } }),
      fetcher: async () => '[1, 2, 3]',
    }, io);
    expect(code).toBe(0);
    expect(client.submissions).toHaveLength(6);
    expect((client.submissions[0].event as any).type).toBe('hn.story_posted');
    expect(client.closed).toBe(true);
    expect(workerCloses).toHaveLength(1);
  });

  it('terminates (exit 1) on a JournalProtocolError from eventSubmit', async () => {
    const io = ioBuf();
    const client = goodClient();
    let submitCalls = 0;
    client.eventSubmit = async () => {
      submitCalls++;
      throw new JournalProtocolError('subscription_missing', 'no trigger');
    };
    const code = await runHnMonitor({
      dataDir: tmp(),
      specPath: specFile(),
      pollIntervalMs: 1,
      maxPolls: 10,
      connectClient: async () => client,
      attachWorker: async (_c, _onErr) => ({ close: async () => {} }),
      fetcher: async () => '[1]',
    }, io);
    expect(code).toBe(1);
    expect(submitCalls).toBe(1);
    expect(io.stderr_lines.some((l) => l.includes('non-transient error, terminating'))).toBe(true);
  });

  it('terminates (exit 1) on a raw socket error (ECONNRESET) — not misclassified as fetch', async () => {
    const io = ioBuf();
    const client = goodClient();
    let submitCalls = 0;
    client.eventSubmit = async () => {
      submitCalls++;
      const err = new Error('read ECONNRESET');
      (err as any).code = 'ECONNRESET';
      throw err;
    };
    const code = await runHnMonitor({
      dataDir: tmp(),
      specPath: specFile(),
      pollIntervalMs: 1,
      maxPolls: 10,
      connectClient: async () => client,
      attachWorker: async (_c, _onErr) => ({ close: async () => {} }),
      fetcher: async () => '[1]',
    }, io);
    expect(code).toBe(1);
    expect(submitCalls).toBe(1);
    expect(io.stderr_lines.some((l) => l.includes('non-transient error, terminating'))).toBe(true);
  });

  it('SURVIVES a typed HnTransientFetchError (continues to next tick)', async () => {
    const io = ioBuf();
    const client = goodClient();
    let call = 0;
    const code = await runHnMonitor({
      dataDir: tmp(),
      specPath: specFile(),
      pollIntervalMs: 1,
      maxPolls: 2,
      connectClient: async () => client,
      attachWorker: async (_c, _onErr) => ({ close: async () => {} }),
      fetcher: async () => {
        call++;
        if (call === 1) throw new HnTransientFetchError('HN fetch failed: HTTP 503');
        return '[7]';
      },
    }, io);
    expect(code).toBe(0);
    expect(client.submissions).toHaveLength(1);
    expect(io.stderr_lines.some((l) => l.includes('poll fetch failed'))).toBe(true);
  });

  it('SURVIVES a fetch()-level TypeError wrapped as HnTransientFetchError by defaultFetcher', async () => {
    // Regression pin: prior classifier used string prefixes, would miss
    // TypeError('fetch failed') / ECONNREFUSED from fetch() itself.
    // Now defaultFetcher wraps them in HnTransientFetchError so the
    // classifier catches them via instanceof.
    const io = ioBuf();
    const client = goodClient();
    let call = 0;
    const code = await runHnMonitor({
      dataDir: tmp(),
      specPath: specFile(),
      pollIntervalMs: 1,
      maxPolls: 2,
      connectClient: async () => client,
      attachWorker: async (_c, _onErr) => ({ close: async () => {} }),
      fetcher: async () => {
        call++;
        if (call === 1) throw new HnTransientFetchError(
          'HN fetch failed: TypeError: fetch failed',
          new TypeError('fetch failed'),
        );
        return '[9]';
      },
    }, io);
    expect(code).toBe(0);
    expect(client.submissions).toHaveLength(1);
  });

  it('terminates (exit 1) when the worker emits an error asynchronously', async () => {
    // AgentWorker.emit('error', ...) fires from step-dispatch callbacks.
    // Without a listener, Node crashes the process. runHnMonitor wires
    // a listener in defaultAttachWorker; here we simulate the worker
    // firing via the onError callback the CLI passes into attach.
    const io = ioBuf();
    const client = goodClient();
    let capturedOnError: ((err: unknown) => void) | undefined;
    const code = await runHnMonitor({
      dataDir: tmp(),
      specPath: specFile(),
      // The loop must still be running when the error lands, or there is
      // nothing to preempt and exiting 0 is correct. 10 polls x 50ms gives a
      // ~500ms window for an error fired at 10ms.
      //
      // It used to be 10 polls x 1ms against that same 10ms timer -- two
      // deadlines of the same size racing. On a loaded CI runner the loop
      // finished first and the test failed with `expected +0 to be 1`, twice
      // tonight (#179), while never reproducing locally. Widening the error to
      // 60ms reproduces the old failure 8 times out of 8, which is what
      // identified this as the test's race rather than the product's.
      pollIntervalMs: 50,
      maxPolls: 10,
      connectClient: async () => client,
      attachWorker: async (_c, onErr) => {
        capturedOnError = onErr;
        // Fire the worker error asynchronously so the loop is already
        // running when it lands — proves the loop preempts on next tick.
        setTimeout(() => capturedOnError?.(new Error('step-dispatch blew up')), 10);
        return { close: async () => {} };
      },
      fetcher: async () => '[1]',
    }, io);
    expect(code).toBe(1);
    expect(io.stderr_lines.some((l) => l.includes('worker emitted error, terminating'))).toBe(true);
    expect(io.stderr_lines.some((l) => l.includes('step-dispatch blew up'))).toBe(true);
  });

  it('exits cleanly on abort signal within one poll', async () => {
    const io = ioBuf();
    const client = goodClient();
    const controller = new AbortController();
    const runPromise = runHnMonitor({
      dataDir: tmp(),
      specPath: specFile(),
      pollIntervalMs: 60_000, // long — proves interruptible sleep works
      signal: controller.signal,
      connectClient: async () => client,
      attachWorker: async (_c, _onErr) => ({ close: async () => {} }),
      fetcher: async () => '[1]',
    }, io);
    setTimeout(() => controller.abort(), 20);
    const code = await runPromise;
    expect(code).toBe(0);
    expect(client.closed).toBe(true);
  });
});
