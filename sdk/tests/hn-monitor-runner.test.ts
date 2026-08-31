/**
 * Unit tests for HnMonitorRunner (Track A v2). These do NOT prove the
 * workload executes end-to-end — that's `hn-monitor-e2e.test.ts` in the
 * same directory, which spins a real relayflowd. These prove:
 *
 *   1. The runner assembles + submits an event per story per tick.
 *   2. Worker attach happens BEFORE first poll (live-kernel contract).
 *   3. Abort signal triggers clean shutdown within one tick.
 *   4. FETCH throw → loop SURVIVES (onFetchError called, next tick still runs).
 *   5. JOURNAL throw (plain transport error) → loop TERMINATES.
 *   6. JOURNAL throw (JournalProtocolError) → loop TERMINATES (regression pin).
 *   7. Invalid inject combo (client without workerInstance) → constructor rejects.
 *   8. Invalid spec source combo (neither / both) → constructor rejects.
 *   9. SpecBundle is frozen once at startup; runtime file changes don't skew.
 *  10. Async worker.close() is awaited on shutdown (drain contract).
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

function makeSpecFile(spec: unknown = FLOW_SPEC): string {
  const dir = mkdtempSync(join(tmpdir(), 'hn-runner-test-'));
  workdirs.push(dir);
  const specPath = join(dir, 'hn-monitor.json');
  writeFileSync(specPath, JSON.stringify(spec));
  return specPath;
}

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

function recordingWorker(events: string[]): RunnerAgentWorker {
  return {
    async attach() { events.push('worker.attach'); },
    close() { events.push('worker.close'); },
  };
}

const workerOpts = { workerId: 'test-w', pins: { relayfile_revision: 'r', worktree_commit: 'c' } as any };

describe('HnMonitorRunner', () => {
  it('submits one event per story on each poll tick', async () => {
    const spec = FLOW_SPEC;
    const client = recordingClient();
    const events: string[] = [];
    const worker = recordingWorker(events);
    const controller = new AbortController();

    const runner = new HnMonitorRunner({
      spec,
      socketPath: '/dev/null',
      pollIntervalMs: 1,
      worker: workerOpts,
      signal: controller.signal,
      fetcher: async () => RECORDED_TOP_STORIES,
      client,
      workerInstance: worker,
      storyLimit: 2,
      maxPolls: 3,
    });

    await runner.run();

    expect(client.submissions).toHaveLength(6); // 3 polls × 2 stories
    expect((client.submissions[0].event as any).type).toBe('hn.story_posted');
    expect((client.submissions[0].event as any).payload).toEqual({ id: 41000001, type: 'story' });
    expect(runner.specBundle?.spec).toEqual(spec);
    expect(runner.specBundle?.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it('attaches the worker BEFORE the first poll (live-kernel contract)', async () => {
    const client = recordingClient();
    const events: string[] = [];
    let firstFetchAt: number | undefined;
    let attachAt: number | undefined;
    const worker: RunnerAgentWorker = {
      async attach() { attachAt = events.length; events.push('worker.attach'); },
      close() { events.push('worker.close'); },
    };
    const runner = new HnMonitorRunner({
      spec: FLOW_SPEC,
      socketPath: '/dev/null',
      pollIntervalMs: 1,
      worker: workerOpts,
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
    expect(attachAt!).toBeLessThan(firstFetchAt!);
  });

  it('aborts within one tick when the signal fires (clean shutdown)', async () => {
    const client = recordingClient();
    const events: string[] = [];
    const worker = recordingWorker(events);
    const controller = new AbortController();
    const runner = new HnMonitorRunner({
      spec: FLOW_SPEC,
      socketPath: '/dev/null',
      pollIntervalMs: 60_000,
      worker: workerOpts,
      signal: controller.signal,
      fetcher: async () => RECORDED_TOP_STORIES,
      client,
      workerInstance: worker,
      storyLimit: 1,
    });
    const runPromise = runner.run();
    setTimeout(() => controller.abort(), 30);
    const started = Date.now();
    await runPromise;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(events).toContain('worker.close');
  });

  it('SURVIVES a fetch throw — onFetchError fires, next tick still runs', async () => {
    const client = recordingClient();
    const events: string[] = [];
    const worker = recordingWorker(events);
    const fetchErrors: unknown[] = [];
    let call = 0;
    const runner = new HnMonitorRunner({
      spec: FLOW_SPEC,
      socketPath: '/dev/null',
      pollIntervalMs: 1,
      worker: workerOpts,
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
    await runner.run();
    expect(fetchErrors).toHaveLength(1);
    expect(client.submissions).toHaveLength(2);
  });

  it('TERMINATES on a journal transport throw', async () => {
    const events: string[] = [];
    const worker = recordingWorker(events);
    const fetchErrors: unknown[] = [];
    let submitCalls = 0;
    const client: RunnerJournalClient = {
      async eventSubmit() { submitCalls++; throw new Error('journal client: connection closed'); },
      close() { events.push('client.close'); },
    };
    const runner = new HnMonitorRunner({
      spec: FLOW_SPEC,
      socketPath: '/dev/null',
      pollIntervalMs: 1,
      worker: workerOpts,
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

  it('TERMINATES on a JournalProtocolError (regression pin)', async () => {
    const events: string[] = [];
    const worker = recordingWorker(events);
    const fetchErrors: unknown[] = [];
    let submitCalls = 0;
    const client: RunnerJournalClient = {
      async eventSubmit() {
        submitCalls++;
        throw new JournalProtocolError('subscription_missing', 'no matching trigger');
      },
      close() { events.push('client.close'); },
    };
    const runner = new HnMonitorRunner({
      spec: FLOW_SPEC,
      socketPath: '/dev/null',
      pollIntervalMs: 1,
      worker: workerOpts,
      fetcher: async () => RECORDED_TOP_STORIES,
      client,
      workerInstance: worker,
      onFetchError: (err) => fetchErrors.push(err),
      storyLimit: 2,
      maxPolls: 10,
    });
    await expect(runner.run()).rejects.toThrow(/subscription_missing/);
    expect(fetchErrors).toHaveLength(0);
    expect(submitCalls).toBe(1);
    expect(events).toContain('worker.close');
  });

  it('REJECTS an invalid inject combo (client without workerInstance)', () => {
    const client: RunnerJournalClient = {
      async eventSubmit() { return { matched: true, deduped: false }; },
    };
    expect(() => new HnMonitorRunner({
      spec: FLOW_SPEC,
      socketPath: '/dev/null',
      worker: workerOpts,
      client,
    })).toThrow(/injecting `client` requires also injecting `workerInstance`/);
  });

  it('REJECTS an invalid spec source combo (neither/both)', () => {
    expect(() => new HnMonitorRunner({
      socketPath: '/dev/null',
      worker: workerOpts,
    })).toThrow(/exactly one of `spec` or `specPath`/);
    expect(() => new HnMonitorRunner({
      spec: FLOW_SPEC,
      specPath: '/dev/null',
      socketPath: '/dev/null',
      worker: workerOpts,
    })).toThrow(/exactly one of `spec` or `specPath`/);
  });

  it('freezes the spec at startup — runtime file changes do not skew subsequent polls', async () => {
    const specPath = makeSpecFile({ name: 'hn-monitor', version: '0.1.0' });
    const client = recordingClient();
    const events: string[] = [];
    const worker = recordingWorker(events);
    let call = 0;
    const runner = new HnMonitorRunner({
      specPath,
      socketPath: '/dev/null',
      pollIntervalMs: 1,
      worker: workerOpts,
      fetcher: async () => {
        call++;
        if (call === 1) {
          // Between poll 1 and poll 2, mutate the on-disk spec.
          writeFileSync(specPath, JSON.stringify({ name: 'evil', version: '9.9.9' }));
        }
        return RECORDED_TOP_STORIES;
      },
      client,
      workerInstance: worker,
      storyLimit: 1,
      maxPolls: 2,
    });
    await runner.run();
    // Both polls submit under the ORIGINAL bundle even though the file changed.
    expect(client.submissions).toHaveLength(2);
    expect(client.submissions[0].spec).toEqual({ name: 'hn-monitor', version: '0.1.0' });
    expect(client.submissions[1].spec).toEqual({ name: 'hn-monitor', version: '0.1.0' });
  });

  it('awaits async worker.close() on shutdown (drain contract)', async () => {
    const client = recordingClient();
    const events: string[] = [];
    let closeStarted = 0;
    let closeFinished = 0;
    const worker: RunnerAgentWorker = {
      async attach() { events.push('worker.attach'); },
      close: async () => {
        closeStarted++;
        // Simulate a drain that takes real time.
        await new Promise((resolve) => setTimeout(resolve, 40));
        closeFinished++;
        events.push('worker.close');
      },
    };
    const runner = new HnMonitorRunner({
      spec: FLOW_SPEC,
      socketPath: '/dev/null',
      pollIntervalMs: 1,
      worker: workerOpts,
      fetcher: async () => RECORDED_TOP_STORIES,
      client,
      workerInstance: worker,
      storyLimit: 1,
      maxPolls: 1,
    });
    await runner.run(); // run must not resolve before close finishes
    expect(closeStarted).toBe(1);
    expect(closeFinished).toBe(1);
    // events order: attach then fetch (implicit) then close AFTER drain
    expect(events).toEqual(['worker.attach', 'worker.close']);
  });
});
