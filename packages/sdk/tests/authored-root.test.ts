import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flow, type Ctx } from '@relayflows/surface';
import { getFlowDefinition } from '@relayflows/surface/runtime';
import { loadAuthoredFlow, type LoadedAuthoredFlow } from '../src/authored-flow-loader.js';
import {
  executeDurableAuthoredFlow,
  readAuthoredRootMetadata,
  resumeDurableAuthoredFlow,
  type AuthoredRootMetadata,
} from '../src/authored-root.js';
import { JournalProtocolError, JournalRequestTimeoutError, type JournalClient } from '../src/journal-client.js';
import type { RunOutcome, StepDispatchEvent } from '../src/protocol.js';
import { AuthoredFlowExecutionError, AuthoredHumanParked } from '../src/authored-flow-error.js';
import { JournalReadInterruptedError } from '../src/journal-read-policy.js';

const nodeRunner = vi.hoisted(() => ({ override: undefined as undefined | ((...args: unknown[]) => Promise<unknown>) }));
vi.mock('../src/authored-node-runner.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../src/authored-node-runner.js')>();
  return { ...actual,
    assertAuthoredRuntimeAvailable: () => { if (nodeRunner.override === undefined) actual.assertAuthoredRuntimeAvailable(); },
    runAuthoredInNode: (...args: Parameters<typeof actual.runAuthoredInNode>) =>
      nodeRunner.override !== undefined ? nodeRunner.override(...args) : actual.runAuthoredInNode(...args) };
});

vi.mock('../src/authored-flow-loader.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/authored-flow-loader.js')>(),
  loadAuthoredFlow: vi.fn(),
}));

const directories: string[] = [];
const surface = Object.freeze({
  packageName: '@relayflows/surface' as const,
  version: '2.0.10',
  packageSha256: 'a'.repeat(64),
  runtimeSha256: 'b'.repeat(64),
});

class RootPeer extends EventEmitter {
  readonly completions: Array<{ attempt: number; reason: string }> = [];
  readonly outputs: Array<Record<string, unknown> | undefined> = [];
  readonly waits: Array<{ attempt: number; wait: Record<string, unknown> }> = [];
  heartbeats = 0;

  async connect() {}
  async hello() {}
  async workerAttach() {}
  async stepHeartbeat() {
    this.heartbeats += 1;
    return { lease_deadline_ms: Date.now() + 30 };
  }
  close() {}

  async stepWait(
    runId: string,
    _stepId: string,
    attempt: number,
    _idempotencyKey: string,
    wait: Record<string, unknown>,
  ): Promise<RunOutcome> {
    this.waits.push({ attempt, wait });
    return outcome(runId, 'parked', null);
  }

  async stepComplete(
    runId: string,
    _stepId: string,
    attempt: number,
    _idempotencyKey: string,
    reason: string,
    result?: { output?: unknown },
  ): Promise<RunOutcome> {
    this.completions.push({ attempt, reason });
    this.outputs.push(result?.output as Record<string, unknown> | undefined);
    if (reason === 'success') return outcome(runId, 'completed', 'success');
    return outcome(runId, 'failed', 'step_failed');
  }
}

class RootJournal {
  readonly peer = new RootPeer();
  readonly starts: Array<{ spec: unknown; admissionKey?: string }> = [];
  runId = 'root-run';
  startStatus: RunOutcome = outcome(this.runId, 'parked', null);
  resumeStatus: RunOutcome = outcome(this.runId, 'parked', null);
  dispatchOnStart = true;
  dispatchLeaseMs = 30;
  resumeCalls = 0;
  entries: Array<Record<string, unknown>> = [];
  readonly childEntries = new Map<string, Array<Record<string, unknown>>>();
  readonly streamed = new Map<string, unknown[]>();

  createPeer(): JournalClient { return this.peer as unknown as JournalClient; }
  async runStart(spec: unknown, _reuse?: string, admissionKey?: string): Promise<RunOutcome> {
    this.starts.push({ spec, ...(admissionKey === undefined ? {} : { admissionKey }) });
    const step = (spec as { steps?: Array<{ id?: string }> }).steps?.[0];
    if (step?.id !== 'authored-root') {
      const childRunId = `child-${step?.id ?? 'unknown'}`;
      this.childEntries.set(childRunId, [{
        entry_type: 'step.completed', step_id: step?.id,
        payload: { completionReason: 'success', output: { stdout_tail: '' } },
      }]);
      return outcome(childRunId, 'completed', 'success');
    }
    if (this.dispatchOnStart
      && (this.startStatus.status === 'running' || this.startStatus.status === 'parked')) {
      queueMicrotask(() => this.peer.emit('step.dispatch', dispatch(this.runId, 1, this.dispatchLeaseMs)));
    }
    return this.startStatus;
  }
  async runResume(runId: string): Promise<RunOutcome> {
    this.resumeCalls += 1;
    if (this.resumeStatus.status === 'running' || this.resumeStatus.status === 'parked') {
      queueMicrotask(() => this.peer.emit('step.dispatch', dispatch(runId, 2, this.dispatchLeaseMs)));
    }
    return this.resumeStatus;
  }
  async journalRead(runId: string, fromSeq = 1): Promise<{ entries: Array<Record<string, unknown>> }> {
    // Numbered like the kernel's `journal.read`, so paginating readers
    // (`readOpenHumanWaits`) terminate against the fake too.
    const entries = (this.childEntries.get(runId) ?? this.entries)
      .map((entry, index) => ({ seq: index + 1, ...entry }));
    return { entries: entries.filter(entry => entry.seq >= fromSeq) };
  }
  // Dense per-stream offsets, as `engine/remote.rs` `read_stream` gives them.
  // The authored child index is written here, so a fake root that cannot
  // append is a root whose children could never be named.
  async streamAppend(runId: string, stream: string, message: unknown): Promise<{ offset: number }> {
    const list = this.streamed.get(`${runId}\u0000${stream}`) ?? [];
    this.streamed.set(`${runId}\u0000${stream}`, list);
    list.push(message);
    return { offset: list.length - 1 };
  }
  async streamRead(runId: string, stream: string, fromOffset: number, limit: number) {
    const list = this.streamed.get(`${runId}\u0000${stream}`) ?? [];
    const messages = list.slice(fromOffset, fromOffset + limit);
    return { messages, next_offset: fromOffset + messages.length };
  }
}

beforeEach(() => {
  vi.mocked(loadAuthoredFlow).mockReset();
});

afterEach(async () => {
  for (const directory of directories.splice(0)) {
    await rm(directory, { recursive: true, force: true });
  }
});

describe('durable authored root', () => {
  it('journals exact source and Surface authority and completes the admitted root', async () => {
    const loaded = await fixture();
    const journal = new RootJournal();

    const result = await executeDurableAuthoredFlow(
      loaded, journal as unknown as JournalClient, { topic: 'relay' },
      { dataDir: '/unused', admissionKey: 'cloud-run-1' },
    );

    expect(result.rootRunId).toBe('root-run');
    expect(journal.starts).toHaveLength(2);
    expect(journal.starts[0]!.admissionKey).toMatch(/^authored-root:[a-f0-9]{64}$/u);
    const step = (journal.starts[0]!.spec as { steps: Array<{ instruction: string }> }).steps[0]!;
    const metadata = JSON.parse(step.instruction) as AuthoredRootMetadata;
    expect(metadata).toMatchObject({
      kind: 'relayflows.authored-root.v1', flowName: 'flagship',
      flowPath: loaded.sourcePath, input: { topic: 'relay' }, surface,
    });
    expect(metadata.sourceSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(metadata.extensions).toEqual([]);
    expect(journal.peer.completions).toEqual([{ attempt: 1, reason: 'success' }]);
  });

  it('stops waiting for a root re-dispatch when the caller cancels', async () => {
    // The root lease is lost (the daemon refuses the renewal), so the driver
    // waits up to 45s for the kernel to re-dispatch the root. A caller cancel
    // during that wait must end it at once, as a cancel -- never a
    // `root_lease_lost` report, and never after the timeout.
    const loaded = await fixture();
    const journal = new RootJournal();
    journal.peer.stepHeartbeat = async () => {
      throw new JournalProtocolError('lease_conflict', 'attempt has no active worker lease');
    };
    const controller = new AbortController();
    const started = Date.now();
    const execution = executeDurableAuthoredFlow(
      loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'cancel-while-redispatch', lifecycle: { signal: controller.signal } },
    );
    setTimeout(() => controller.abort(), 200);
    await expect(execution).rejects.toThrow('re-dispatched was canceled');
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(journal.peer.completions).toEqual([]);
  });

  it('does not wait for a re-dispatch after the root run is terminal', async () => {
    const loaded = await fixture();
    const journal = new RootJournal();
    journal.dispatchLeaseMs = 30_000;
    const terminal = Object.assign(new JournalProtocolError('run_terminal', 'run is already terminal'), {
      verb: 'step.complete',
    });
    journal.peer.stepHeartbeat = async () => ({ lease_deadline_ms: Date.now() + 30_000 });
    journal.peer.stepComplete = async () => { throw terminal; };
    const controller = new AbortController();
    const abort = setTimeout(() => controller.abort(), 2_000);
    try {
      await expect(executeDurableAuthoredFlow(
        loaded, journal as unknown as JournalClient, undefined,
        { dataDir: '/unused', admissionKey: 'terminal-root', lifecycle: { signal: controller.signal } },
      )).rejects.toBe(terminal);
    } finally {
      clearTimeout(abort);
    }
  });

  it('journals plugin digests from composed extensions', async () => {
    const loaded = await fixture();
    const extension = {
      name: 'babysitter',
      digest: 'c'.repeat(64),
      ref: `github:AgentWorkforce/flows@${'a'.repeat(40)}#examples/babysitter`,
    };
    const journal = new RootJournal();
    await executeDurableAuthoredFlow(
      { ...loaded, extensions: [extension as LoadedAuthoredFlow['extensions'][number]] },
      journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'with-plugin' },
    );
    const step = (journal.starts[0]!.spec as { steps: Array<{ instruction: string }> }).steps[0]!;
    const metadata = JSON.parse(step.instruction) as AuthoredRootMetadata;
    expect(metadata.extensions).toEqual([extension]);
  });

  it('reconciles a lost start acknowledgement from the durable root result', async () => {
    const loaded = await fixture();
    const journal = new RootJournal();
    journal.startStatus = outcome(journal.runId, 'completed', 'success');
    journal.entries = [completedEntry()];

    const result = await executeDurableAuthoredFlow(
      loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'same-request' },
    );

    expect(result).toMatchObject({ rootRunId: 'root-run', name: 'flagship', completionReason: 'success' });
    expect(journal.peer.completions).toEqual([]);
  });

  it('recovers declined from the completed root without executing the body', async () => {
    const loaded = await fixture();
    const journal = new RootJournal();
    journal.startStatus = outcome(journal.runId, 'completed', 'success');
    journal.entries = [completedEntry('declined')];
    const result = await executeDurableAuthoredFlow(
      loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'declined' },
    );
    expect(result).toMatchObject({ rootRunId: 'root-run', completionReason: 'declined' });
    expect(journal.starts).toHaveLength(1);
    expect(journal.peer.completions).toEqual([]);
  });

  it('fails closed on a malformed completed root result', async () => {
    const loaded = await fixture();
    const journal = new RootJournal();
    journal.startStatus = outcome(journal.runId, 'completed', 'success');
    journal.entries = [{
      entry_type: 'step.completed', step_id: 'authored-root',
      payload: { completionReason: 'success', output: {
        name: 'flagship', completionReason: 'invented',
        journalSteps: [{ id: 'run-1', runId: 'child-1', completionReason: 'success' }],
      } },
    }];

    await expect(executeDurableAuthoredFlow(
      loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'malformed-completed-result' },
    )).rejects.toThrow('completed authored root has no durable result');
  });

  it('journals the authored detail on the root step output', async () => {
    const loaded = await fixture(false, 0, async (f: Ctx) => {
      f.done('step_failed', { detail: 'review found 1 P2: review.clean was not created' });
    });
    const journal = new RootJournal();

    const result = await executeDurableAuthoredFlow(
      loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'with-detail' },
    );

    expect(result.completionDetail).toBe('review found 1 P2: review.clean was not created');
    expect(journal.peer.outputs.at(-1)).toMatchObject({
      name: 'flagship',
      completionReason: 'step_failed',
      completionDetail: 'review found 1 P2: review.clean was not created',
    });
  });

  it('leaves the root output without the key when the body passed no detail', async () => {
    const loaded = await fixture();
    const journal = new RootJournal();

    await executeDurableAuthoredFlow(
      loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'no-detail' },
    );

    const output = journal.peer.outputs.at(-1)!;
    expect(output['completionReason']).toBe('success');
    expect('completionDetail' in output).toBe(false);
  });

  it('recovers the stored detail from a completed root without re-running the body', async () => {
    let bodyRuns = 0;
    const loaded = await fixture(false, 0, async (f: Ctx) => {
      bodyRuns += 1;
      f.done('step_failed', { detail: 'recomputed from the CURRENT environment' });
    });
    const journal = new RootJournal();
    journal.startStatus = outcome(journal.runId, 'completed', 'success');
    journal.entries = [completedEntry('step_failed', 'as journaled on the first attempt')];

    const result = await executeDurableAuthoredFlow(
      loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'completed-with-detail' },
    );

    // The DURABLE detail, not one recomputed here: redaction reads the current
    // environment, so a second computation can differ from what was recorded.
    expect(result).toMatchObject({
      completionReason: 'step_failed',
      completionDetail: 'as journaled on the first attempt',
    });
    expect(bodyRuns).toBe(0);
    expect(journal.peer.completions).toEqual([]);
  });

  it('reads back a legacy completed root that carries no detail', async () => {
    const loaded = await fixture();
    const journal = new RootJournal();
    journal.startStatus = outcome(journal.runId, 'completed', 'success');
    journal.entries = [completedEntry('step_failed')];

    const result = await executeDurableAuthoredFlow(
      loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'legacy-no-detail' },
    );

    expect(result.completionReason).toBe('step_failed');
    expect(result.completionDetail).toBeUndefined();
    expect('completionDetail' in result).toBe(false);
  });

  it.each([
    ['a non-string detail', 7],
    ['an over-long detail', 'a'.repeat(2001)],
    ['an empty detail', ''],
  ])('fails closed on %s in the completed root output', async (_label, detail) => {
    const loaded = await fixture();
    const journal = new RootJournal();
    journal.startStatus = outcome(journal.runId, 'completed', 'success');
    journal.entries = [{
      entry_type: 'step.completed', step_id: 'authored-root',
      payload: { completionReason: 'success', output: {
        name: 'flagship', completionReason: 'step_failed', journalSteps: [], completionDetail: detail,
      } },
    }];

    await expect(executeDurableAuthoredFlow(
      loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: `malformed-detail-${String(detail).length}` },
    )).rejects.toThrow('completed authored root has no durable result');
  });

  it('recovers a same-daemon start retry whose original worker lost its dispatch', async () => {
    const loaded = await fixture();
    const journal = new RootJournal();
    journal.dispatchOnStart = false;

    const result = await executeDurableAuthoredFlow(
      loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'same-daemon-lost-dispatch' },
    );

    expect(result).toMatchObject({ rootRunId: 'root-run', completionReason: 'success' });
    expect(journal.resumeCalls).toBe(1);
    expect(journal.peer.completions).toEqual([{ attempt: 2, reason: 'success' }]);
  });

  it('does not terminalize a root whose heartbeat times out', async () => {
    const loaded = await fixture();
    const journal = new RootJournal();
    const controller = new AbortController();
    journal.peer.stepHeartbeat = async () => {
      controller.abort();
      throw new JournalRequestTimeoutError('step.heartbeat', 10);
    };
    await expect(executeDurableAuthoredFlow(loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'heartbeat-timeout', lifecycle: { signal: controller.signal } }))
      .rejects.toThrow();
    expect(journal.peer.completions).toEqual([]);
  });

  it('still terminalizes a timed-out mutation as a body failure', async () => {
    const loaded = await fixture(false, 0, async () => { throw new JournalRequestTimeoutError('stream.append', 10); });
    const journal = new RootJournal();
    await expect(executeDurableAuthoredFlow(loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'write-timeout' })).rejects.toMatchObject({ verb: 'stream.append' });
    expect(journal.peer.completions).toEqual([{ attempt: 1, reason: 'worker_error' }]);
  });

  it.each([false, true])('leaves the root resumable after a read timeout without waiting for redispatch (Node frame=%s)', async nodeFrame => {
    const timeout = new JournalRequestTimeoutError('run.get', 10);
    const loaded = await fixture(false, 0, async () => {
      throw nodeFrame ? new AuthoredFlowExecutionError('daemon_unresponsive', timeout.message) : timeout;
    });
    const journal = new RootJournal();
    await expect(executeDurableAuthoredFlow(loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'read-timeout' })).rejects.toMatchObject({
        code: 'daemon_unresponsive', rootRunId: 'root-run', message: expect.stringContaining('flows resume'),
      });
    expect(journal.peer.completions).toEqual([]);
    expect(journal.resumeCalls).toBe(1);
  });

  it('leaves the root resumable when the read session disconnects while the root worker is healthy', async () => {
    const interrupted = new JournalReadInterruptedError('run.get', 2, 40, 300_000,
      { cause: new Error('journal client: connection closed') });
    const loaded = await fixture(false, 0, async () => { throw interrupted; });
    const journal = new RootJournal();
    await expect(executeDurableAuthoredFlow(loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'read-disconnect' })).rejects.toMatchObject({
        code: 'daemon_unresponsive', rootRunId: 'root-run', message: expect.stringContaining('flows resume'),
      });
    expect(journal.peer.completions).toEqual([]);
  });

  it('never terminalizes the root for a caller cancellation', async () => {
    const controller = new AbortController();
    const loaded = await fixture(false, 0, async () => {
      controller.abort(new Error('caller canceled the run'));
      throw controller.signal.reason;
    });
    const journal = new RootJournal();
    await expect(executeDurableAuthoredFlow(loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'caller-cancel', lifecycle: { signal: controller.signal } }))
      .rejects.toMatchObject({ message: 'caller canceled the run', rootRunId: 'root-run' });
    expect(journal.peer.completions).toEqual([]);
  });

  it('scopes body reads to the root attempt lease for the life of the attempt', async () => {
    const loaded = await fixture();
    const journal = new RootJournal();
    const release = vi.fn();
    const scopeReads = vi.fn((_signal: AbortSignal) => release);
    (journal as unknown as { scopeReads: typeof scopeReads }).scopeReads = scopeReads;
    await executeDurableAuthoredFlow(loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'scoped-reads' }).catch(() => undefined);
    expect(scopeReads).toHaveBeenCalledTimes(1);
    expect(scopeReads.mock.calls[0]![0]).toBeInstanceOf(AbortSignal);
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('propagates a read interruption while detecting an authored root instead of guessing declarative', async () => {
    const { readAuthoredRootMetadata } = await import('../src/authored-root.js');
    const interrupted = { journalRead: async () => { throw new JournalRequestTimeoutError('journal.read', 10, 3, 300_000, 300_000); } };
    await expect(readAuthoredRootMetadata(interrupted as unknown as JournalClient, 'run')).rejects.toBeInstanceOf(JournalRequestTimeoutError);
    const plain = { journalRead: async () => ({ entries: [] }) };
    await expect(readAuthoredRootMetadata(plain as unknown as JournalClient, 'run')).resolves.toBeUndefined();
  });

  it('keeps the lease read scope for the whole Bun-run attempt', async () => {
    const loaded = await fixture();
    const journal = new RootJournal();
    const release = vi.fn();
    (journal as unknown as { scopeReads: (signal: AbortSignal) => () => void }).scopeReads = () => release;
    let finish!: (value: unknown) => void;
    nodeRunner.override = () => new Promise(resolve => { finish = resolve; });
    Object.defineProperty(process.versions, 'bun', { value: '1.4.0', configurable: true });
    try {
      const execution = executeDurableAuthoredFlow(loaded, journal as unknown as JournalClient, undefined,
        { dataDir: '/unused', admissionKey: 'bun-scope' }).catch(() => undefined);
      await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
      expect(release).not.toHaveBeenCalled(); // the child is still running
      finish({ name: 'f', completionReason: 'success', journalSteps: [] });
      await execution;
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      delete (process.versions as Record<string, string | undefined>)['bun'];
      nodeRunner.override = undefined;
    }
  });

  it('keeps a completed root outcome when reading back its result is interrupted', async () => {
    const loaded = await fixture();
    const journal = new RootJournal();
    (journal as unknown as { startStatus: RunOutcome }).startStatus = outcome('root-run', 'completed', 'success');
    journal.journalRead = async () => { throw new JournalRequestTimeoutError('journal.read', 10, 3, 300_000, 300_000); };
    await expect(executeDurableAuthoredFlow(loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'completed-unread' })).rejects.toMatchObject({
        code: 'result_unreadable', completionReason: undefined, rootRunId: 'root-run',
      });
  });

  it('propagates a cancellation while detecting an authored root, but trusts a definite answer', async () => {
    const { readAuthoredRootMetadata } = await import('../src/authored-root.js');
    const canceled = { journalRead: async () => { throw new DOMException('This operation was aborted', 'AbortError'); } };
    await expect(readAuthoredRootMetadata(canceled as unknown as JournalClient, 'run')).rejects.toMatchObject({ name: 'AbortError' });
    const absent = { journalRead: async () => { throw new JournalProtocolError('run_not_found', 'no such run'); } };
    await expect(readAuthoredRootMetadata(absent as unknown as JournalClient, 'run')).resolves.toBeUndefined();
  });

  it('keeps a completed root outcome when reading back its result is canceled', async () => {
    const loaded = await fixture();
    const journal = new RootJournal();
    (journal as unknown as { startStatus: RunOutcome }).startStatus = outcome('root-run', 'completed', 'success');
    journal.journalRead = async () => { throw new DOMException('This operation was aborted', 'AbortError'); };
    await expect(executeDurableAuthoredFlow(loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'completed-canceled' })).rejects.toMatchObject({ code: 'result_unreadable', rootRunId: 'root-run' });
  });

  it('propagates a daemon-side read failure while detecting an authored root', async () => {
    const { readAuthoredRootMetadata } = await import('../src/authored-root.js');
    const storage = { journalRead: async () => { throw new JournalProtocolError('journal_write_failed', 'storage failed'); } };
    await expect(readAuthoredRootMetadata(storage as unknown as JournalClient, 'run')).rejects.toMatchObject({ code: 'journal_write_failed' });
  });

  it('keeps a completed root outcome when its readback meets a storage protocol error', async () => {
    const loaded = await fixture();
    const journal = new RootJournal();
    (journal as unknown as { startStatus: RunOutcome }).startStatus = outcome('root-run', 'completed', 'success');
    journal.journalRead = async () => { throw new JournalProtocolError('journal_write_failed', 'storage failed'); };
    await expect(executeDurableAuthoredFlow(loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'completed-storage' })).rejects.toMatchObject({ code: 'result_unreadable', rootRunId: 'root-run' });
  });

  it('terminalizes a returned body failure without replaying semantic side effects', async () => {
    const loaded = await fixture(true);
    const journal = new RootJournal();

    await expect(executeDurableAuthoredFlow(
      loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'failure' },
    )).rejects.toThrow('child failed');
    expect(journal.peer.completions).toEqual([{ attempt: 1, reason: 'worker_error' }]);
  });

  it('renews the authored root lease while its body is still running', async () => {
    const loaded = await fixture(false, 100);
    const journal = new RootJournal();

    await executeDurableAuthoredFlow(
      loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'slow-body' },
    );

    expect(journal.peer.heartbeats).toBeGreaterThan(2);
    expect(journal.peer.completions).toEqual([{ attempt: 1, reason: 'success' }]);
  });

  it('resumes from journaled source and Surface authority under the same root identity', async () => {
    const loaded = await fixture();
    const journal = new RootJournal();
    journal.entries = [spawnedEntry(loaded)];
    vi.mocked(loadAuthoredFlow).mockResolvedValue(loaded);

    const result = await resumeDurableAuthoredFlow(
      journal.runId, journal as unknown as JournalClient, { dataDir: '/unused' },
    );

    expect(result).toMatchObject({ rootRunId: 'root-run', name: 'flagship' });
    expect(journal.peer.completions).toEqual([{ attempt: 2, reason: 'success' }]);
  });

  it('parks the root attempt on an unanswered f.human instead of completing it', async () => {
    const loaded = await fixture(false, 0, async f => { await f.human('Ship it?', { to: 'khaliq' }); f.done('success'); });
    const journal = new RootJournal();

    const failure = await executeDurableAuthoredFlow(
      loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'ask' },
    ).catch(error => error);

    expect(failure).toBeInstanceOf(AuthoredHumanParked);
    expect((failure as AuthoredHumanParked).wait).toEqual({ waitId: 'human-1', question: 'Ship it?', to: 'khaliq' });
    // The attempt asked a question: `step.wait` under the body's own wait id,
    // never `step.complete`, and never the worker_error retry ladder.
    expect(journal.peer.waits).toEqual([{ attempt: 1, wait: {
      wait_id: 'human-1', prompt: 'Ship it?', requested_of: 'khaliq', options: ['yes', 'no'],
    } }]);
    expect(journal.peer.completions).toEqual([]);
  });

  it('reports the open question on resume instead of waiting for a dispatch that cannot come', async () => {
    const loaded = await fixture();
    const journal = new RootJournal();
    journal.entries = [spawnedEntry(loaded), {
      entry_type: 'wait.human', step_id: 'authored-root', attempt: 1,
      payload: { wait_id: 'human-1', prompt: 'Ship it?', requested_of: 'khaliq' },
    }];
    journal.resumeStatus = outcome(journal.runId, 'parked', null);
    // A parked root is not dispatched by the kernel; the fake must not either.
    journal.runResume = async function (this: RootJournal) { this.resumeCalls += 1; return this.resumeStatus; };
    vi.mocked(loadAuthoredFlow).mockResolvedValue(loaded);

    const failure = await resumeDurableAuthoredFlow(
      journal.runId, journal as unknown as JournalClient, { dataDir: '/unused' },
    ).catch(error => error);

    expect(failure).toBeInstanceOf(AuthoredHumanParked);
    expect((failure as AuthoredHumanParked).wait).toMatchObject({ waitId: 'human-1', question: 'Ship it?', to: 'khaliq' });
    expect(journal.peer.completions).toEqual([]);
  });

  it('resumes past an answered question: the wait is closed, the body re-runs and completes', async () => {
    const loaded = await fixture(false, 0, async f => {
      const ok = await f.human('Ship it?', { to: 'khaliq' });
      f.done(ok ? 'success' : 'declined');
    });
    const journal = new RootJournal();
    journal.entries = [spawnedEntry(loaded), {
      entry_type: 'wait.human', step_id: 'authored-root', attempt: 1,
      payload: { wait_id: 'human-1', prompt: 'Ship it?', requested_of: 'khaliq' },
    }, {
      entry_type: 'wait.completed', step_id: 'authored-root', attempt: 1,
      payload: { wait_id: 'human-1', completionReason: 'human_responded', result: { answer: false, answeredBy: 'khaliq', at_ms: 1, attribution: 'client_asserted' } },
    }];
    vi.mocked(loadAuthoredFlow).mockResolvedValue(loaded);

    const result = await resumeDurableAuthoredFlow(
      journal.runId, journal as unknown as JournalClient, { dataDir: '/unused' },
    );

    expect(result).toMatchObject({ rootRunId: 'root-run', completionReason: 'declined' });
    expect(result!.journalSteps.map(step => step.id)).toEqual(['human-1', 'complete-2']);
    expect(journal.peer.waits).toEqual([]);
    expect(journal.peer.completions).toEqual([{ attempt: 2, reason: 'success' }]);
  });

  it('fails closed on malformed metadata under the reserved authored-root stream', async () => {
    const journal = new RootJournal();
    journal.entries = [{
      entry_type: 'run.spawned', payload: { spec: { steps: [{
        id: 'authored-root', instruction: '{bad',
        surfaces: { streams: [{ stream: 'authored-root-reserved' }] },
      }] } },
    }];
    await expect(readAuthoredRootMetadata(
      journal as unknown as JournalClient, journal.runId,
    )).rejects.toThrow('malformed authority metadata');
  });
});

async function fixture(
  fails = false,
  delayMs = 0,
  body?: Parameters<typeof flow>[1],
): Promise<LoadedAuthoredFlow> {
  const directory = await mkdtemp(join(tmpdir(), 'authored-root-'));
  directories.push(directory);
  const sourcePath = join(directory, 'flagship.flow.ts');
  await writeFile(sourcePath, 'export default "exact source";\n');
  const handle = body !== undefined
    ? flow('flagship', body)
    : fails
      ? flow('flagship', async () => { throw new Error('child failed'); })
      : flow('flagship', async f => {
        if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
        f.done('success');
      });
  const getDefinition = getFlowDefinition as LoadedAuthoredFlow['getDefinition'];
  return {
    sourcePath, handle, getDefinition, surfaceAuthority: surface,
    graph: [{ path: sourcePath, handle, getDefinition, surfaceAuthority: surface, use: [] }],
    extensions: [],
  };
}

function dispatch(runId: string, attempt: number, leaseMs = 30): StepDispatchEvent {
  return {
    run_id: runId, step_id: 'authored-root', attempt, step_type: 'agent', spec: {},
    lease_id: `lease-${attempt}`, idempotency_key: `key-${attempt}`,
    lease_deadline_ms: Date.now() + leaseMs,
    pins: { workspace: [], streams: [{ stream: 'authored-root-stream', read_offset: 0 }] },
  };
}

function outcome(
  runId: string,
  status: RunOutcome['status'],
  completionReason: RunOutcome['completion_reason'],
): RunOutcome {
  return { run_id: runId, status, completion_reason: completionReason, completed_steps: 0 };
}

function spawnedEntry(loaded: LoadedAuthoredFlow): Record<string, unknown> {
  const metadata: AuthoredRootMetadata = {
    kind: 'relayflows.authored-root.v1', flowName: 'flagship', flowPath: loaded.sourcePath,
    sourceSha256: '76fd521c5bda4f37b3c69a6ae3c5a97f0a2ba53d3d8b09d9cc9709f809f5a5a2',
    surface,
    sources: [{
      path: loaded.sourcePath,
      sourceSha256: '76fd521c5bda4f37b3c69a6ae3c5a97f0a2ba53d3d8b09d9cc9709f809f5a5a2',
      surface,
    }],
    extensions: [],
    inputPresent: false,
  };
  return {
    entry_type: 'run.spawned', payload: { spec: { steps: [{
      id: 'authored-root',
      instruction: JSON.stringify(metadata),
      surfaces: { streams: [{ stream: 'authored-root-stream' }] },
    }] } },
  };
}

function completedEntry(reason = 'success', detail?: string): Record<string, unknown> {
  return {
    entry_type: 'step.completed', step_id: 'authored-root',
    payload: { completionReason: 'success', output: {
      name: 'flagship', completionReason: reason, journalSteps: [],
      ...(detail === undefined ? {} : { completionDetail: detail }),
    } },
  };
}
