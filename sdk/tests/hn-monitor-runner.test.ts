/**
 * Unit tests for HnMonitorRunner. These do NOT prove the workload executes
 * end-to-end — that is sub-PR B (integration test against a real
 * relayflowd). These prove:
 *
 *   1. The runner assembles: fake fetch + mock journal client → an event
 *      submission happens on each tick.
 *   2. Worker attach happens BEFORE the first poll (live-kernel contract).
 *   3. Abort signal triggers clean shutdown within one tick.
 *   4. FETCH throw → loop SURVIVES (onFetchError called, next tick still runs).
 *   5. JOURNAL throw → loop TERMINATES (run() rejects with the error).
 *
 * Requirements 4 and 5 exist because deleting them and rebuilding the
 * onFetchError branch or the journal-error propagation would silently break
 * the fail-closed contract from covenant 2.
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it, afterEach } from 'vitest';
import { HnMonitorRunner, type RunnerAgentWorker, type RunnerJournalClient } from '../src/hn-monitor-runner.js';
import { JournalProtocolError } from '../src/journal-client.js';

const RECORDED_TOP_STORIES = '[41000001, 41000002, 41000003]';
const FLOW_SPEC = { name: 'hn-monitor', version: '0.1.0' };

const workdirs: string[] = [];
afterEach(() => {
  for (const dir of workdirs.splice(0)) {
    try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

function makeSpecFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'hn-runner-test-'));
  workdirs.push(dir);
  const specPath = join(dir, 'hn-monitor.json');
  writeFileSync(specPath, JSON.stringify(FLOW_SPEC));
  return specPath;
}

/** A journal client mock that records submissions. */
function recordingClient(): RunnerJournalClient & {
  submissions: Array<{ spec: unknown; event: unknown }>;
  closed: boolean;
} {
  const submissions: Array<{ spec: unknown; event: unknown }> = [];
  let closed = false;
  return {
    get submissions() { return submissions; },
    get closed() { return closed; },
    async eventSubmit(spec, event) {
      submissions.push({ spec, event });
      return { matched: true, deduped: false };
    },
    close() { closed = true; },
  } as unknown as RunnerJournalClient & { submissions: typeof submissions; closed: boolean };
}

/** A worker mock that records attach ordering. */
function recordingWorker(events: string[]): RunnerAgentWorker {
  return {
    async attach() { events.push('worker.attach'); },
    close() { events.push('worker.close'); },
  };
}

describe('HnMonitorRunner', () => {
  it('submits one event per story on each poll tick (assembly test)', async () => {
    const specPath = makeSpecFile();
    const client = recordingClient();
    const events: string[] = [];
    const worker = recordingWorker(events);
    const controller = new AbortController();

    const runner = new HnMonitorRunner({
      specPath,
      socketPath: '/dev/null',
      pollIntervalMs: 1,
      worker: { workerId: 'test-w', pins: { relayfile_revision: 'r', worktree_commit: 'c' } as any },
      signal: controller.signal,
      fetcher: async () => RECORDED_TOP_STORIES,
      client,
      workerInstance: worker,
      storyLimit: 2,
      maxPolls: 3,
    });

    await runner.run();

    // 3 polls × 2 stories = 6 submissions.
    expect(client.submissions).toHaveLength(6);
    expect((client.submissions[0].event as any).type).toBe('hn.story_posted');
    expect((client.submissions[0].event as any).payload).toEqual({ id: 41000001, type: 'story' });
  });

  it('attaches the worker BEFORE the first poll (live-kernel contract)', async () => {
    const specPath = makeSpecFile();
    const client = recordingClient();
    const events: string[] = [];
    // Wrap fetcher so we can record when a fetch fired relative to attach.
    let firstFetchAt: number | undefined;
    let attachAt: number | undefined;
    const worker: RunnerAgentWorker = {
      async attach() {
        attachAt = events.length;
        events.push('worker.attach');
      },
      close() { events.push('worker.close'); },
    };

    const runner = new HnMonitorRunner({
      specPath,
      socketPath: '/dev/null',
      pollIntervalMs: 1,
      worker: { workerId: 'test-w', pins: { relayfile_revision: 'r', worktree_commit: 'c' } as any },
      fetcher: async () => {
        if (firstFetchAt === undefined) firstFetchAt = events.length;
        events.push('fetch');
        return RECORDED_TOP_STORIES;
      },
      client,
      workerInstance: worker,
      maxPolls: 1,
    });

    await runner.run();

    expect(attachAt).toBeDefined();
    expect(firstFetchAt).toBeDefined();
    // Attach must appear in the recorded events before ANY fetch.
    expect(attachAt!).toBeLessThan(firstFetchAt!);
  });

  it('aborts within one tick when the signal fires (clean shutdown)', async () => {
    const specPath = makeSpecFile();
    const client = recordingClient();
    const events: string[] = [];
    const worker = recordingWorker(events);
    const controller = new AbortController();

    const runner = new HnMonitorRunner({
      specPath,
      socketPath: '/dev/null',
      pollIntervalMs: 60_000, // large — proves the interruptible sleep works
      worker: { workerId: 'test-w', pins: { relayfile_revision: 'r', worktree_commit: 'c' } as any },
      signal: controller.signal,
      fetcher: async () => RECORDED_TOP_STORIES,
      client,
      workerInstance: worker,
      storyLimit: 1,
    });

    const runPromise = runner.run();
    // Fire the abort after the first tick has started; the runner should
    // finish the current tick and then exit rather than waiting the full 60s.
    setTimeout(() => controller.abort(), 30);

    const started = Date.now();
    await runPromise;
    const elapsed = Date.now() - started;

    // Must be much less than the poll interval; generous bound for CI jitter.
    expect(elapsed).toBeLessThan(5_000);
    expect(events).toContain('worker.close');
  });

  it('SURVIVES a fetch throw — onFetchError fires, the next tick still runs', async () => {
    const specPath = makeSpecFile();
    const client = recordingClient();
    const events: string[] = [];
    const worker = recordingWorker(events);
    const fetchErrors: unknown[] = [];

    let call = 0;
    const runner = new HnMonitorRunner({
      specPath,
      socketPath: '/dev/null',
      pollIntervalMs: 1,
      worker: { workerId: 'test-w', pins: { relayfile_revision: 'r', worktree_commit: 'c' } as any },
      fetcher: async () => {
        call++;
        if (call === 1) throw new Error('simulated HN 503');
        return RECORDED_TOP_STORIES;
      },
      client,
      workerInstance: worker,
      onFetchError: (err) => fetchErrors.push(err),
      storyLimit: 2,
      maxPolls: 2,
    });

    await runner.run(); // must resolve, not reject.

    expect(fetchErrors).toHaveLength(1);
    // Only the successful tick submits (2 stories).
    expect(client.submissions).toHaveLength(2);
  });

  it('TERMINATES on a journal transport throw — run() rejects, loop does not continue', async () => {
    const specPath = makeSpecFile();
    const events: string[] = [];
    const worker = recordingWorker(events);
    const fetchErrors: unknown[] = [];

    // A journal client whose eventSubmit throws a journal transport error
    // (plain Error with `journal client:` prefix — the shape JournalClient
    // throws for connect/socket/framing failures).
    let submitCalls = 0;
    const client: RunnerJournalClient = {
      async eventSubmit() {
        submitCalls++;
        throw new Error('journal client: connection closed');
      },
      close() { events.push('client.close'); },
    };

    const runner = new HnMonitorRunner({
      specPath,
      socketPath: '/dev/null',
      pollIntervalMs: 1,
      worker: { workerId: 'test-w', pins: { relayfile_revision: 'r', worktree_commit: 'c' } as any },
      fetcher: async () => RECORDED_TOP_STORIES,
      client,
      workerInstance: worker,
      onFetchError: (err) => fetchErrors.push(err),
      storyLimit: 2,
      maxPolls: 10,
    });

    await expect(runner.run()).rejects.toThrow(/journal client/);
    expect(fetchErrors).toHaveLength(0);
    expect(submitCalls).toBe(1);
    expect(events).toContain('worker.close');
  });

  it('TERMINATES on a JournalProtocolError — kernel-side rejection is not misclassified as fetch', async () => {
    // Regression test for the swarm finding on #85 iteration 1: an earlier
    // heuristic classified journal errors by message-prefix and missed
    // JournalProtocolError entirely (message format is `<code>: <message>`,
    // not `journal client: ...`). That silently forwarded real kernel
    // rejections to onFetchError — fail-open, in violation of covenant 2.
    // The fix: `instanceof JournalProtocolError` in the classifier.
    const specPath = makeSpecFile();
    const events: string[] = [];
    const worker = recordingWorker(events);
    const fetchErrors: unknown[] = [];

    let submitCalls = 0;
    const client: RunnerJournalClient = {
      async eventSubmit() {
        submitCalls++;
        // Exact shape JournalClient throws when the server rejects a request:
        // `new JournalProtocolError(res.error.code, res.error.message)`.
        throw new JournalProtocolError('subscription_missing', 'no matching trigger');
      },
      close() { events.push('client.close'); },
    };

    const runner = new HnMonitorRunner({
      specPath,
      socketPath: '/dev/null',
      pollIntervalMs: 1,
      worker: { workerId: 'test-w', pins: { relayfile_revision: 'r', worktree_commit: 'c' } as any },
      fetcher: async () => RECORDED_TOP_STORIES,
      client,
      workerInstance: worker,
      onFetchError: (err) => fetchErrors.push(err),
      storyLimit: 2,
      maxPolls: 10,
    });

    // Must reject; must NOT swallow to onFetchError.
    await expect(runner.run()).rejects.toThrow(/subscription_missing/);
    expect(fetchErrors).toHaveLength(0);
    expect(submitCalls).toBe(1);
    expect(events).toContain('worker.close');
  });

  it('REJECTS an invalid inject combo (client without workerInstance)', async () => {
    // The runner refuses to construct AgentWorker over a duck-typed
    // RunnerJournalClient because that would launder a type mismatch —
    // AgentWorker needs workerAttach/stepComplete/on/off which
    // RunnerJournalClient doesn't carry. Fail-closed on the invalid combo.
    const specPath = makeSpecFile();
    const client: RunnerJournalClient = {
      async eventSubmit() { return { matched: true, deduped: false }; },
    };
    expect(() => new HnMonitorRunner({
      specPath,
      socketPath: '/dev/null',
      worker: { workerId: 'test-w', pins: { relayfile_revision: 'r', worktree_commit: 'c' } as any },
      client,
      // no workerInstance
    })).toThrow(/injecting `client` requires also injecting `workerInstance`/);
  });
});
