import { EventEmitter } from 'node:events';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { flow } from '@relayflows/surface';
import { getFlowDefinition } from '@relayflows/surface/runtime';
import { loadAuthoredFlow, type LoadedAuthoredFlow } from '../src/authored-flow-loader.js';
import {
  executeDurableAuthoredFlow,
  readAuthoredRootMetadata,
  resumeDurableAuthoredFlow,
  type AuthoredRootMetadata,
} from '../src/authored-root.js';
import type { JournalClient } from '../src/journal-client.js';
import type { RunOutcome, StepDispatchEvent } from '../src/protocol.js';

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
  heartbeats = 0;

  async connect() {}
  async hello() {}
  async workerAttach() {}
  async stepHeartbeat() {
    this.heartbeats += 1;
    return { lease_deadline_ms: Date.now() + 30 };
  }
  close() {}

  async stepComplete(
    runId: string,
    _stepId: string,
    attempt: number,
    _idempotencyKey: string,
    reason: string,
  ): Promise<RunOutcome> {
    this.completions.push({ attempt, reason });
    if (reason === 'success') return outcome(runId, 'completed', 'success');
    if (attempt >= 8) return outcome(runId, 'failed', 'step_failed');
    queueMicrotask(() => this.emit('step.dispatch', dispatch(runId, attempt + 1)));
    return outcome(runId, 'parked', null);
  }
}

class RootJournal {
  readonly peer = new RootPeer();
  readonly starts: Array<{ spec: unknown; admissionKey?: string }> = [];
  runId = 'root-run';
  startStatus: RunOutcome = outcome(this.runId, 'parked', null);
  resumeStatus: RunOutcome = outcome(this.runId, 'parked', null);
  dispatchOnStart = true;
  resumeCalls = 0;
  entries: Array<Record<string, unknown>> = [];
  readonly childEntries = new Map<string, Array<Record<string, unknown>>>();

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
      queueMicrotask(() => this.peer.emit('step.dispatch', dispatch(this.runId, 1)));
    }
    return this.startStatus;
  }
  async runResume(runId: string): Promise<RunOutcome> {
    this.resumeCalls += 1;
    if (this.resumeStatus.status === 'running' || this.resumeStatus.status === 'parked') {
      queueMicrotask(() => this.peer.emit('step.dispatch', dispatch(runId, 2)));
    }
    return this.resumeStatus;
  }
  async journalRead(runId: string): Promise<{ entries: Array<Record<string, unknown>> }> {
    return { entries: this.childEntries.get(runId) ?? this.entries };
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
    expect(journal.peer.completions).toEqual([{ attempt: 1, reason: 'success' }]);
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

  it('drives declared root retries to a durable terminal after a body failure', async () => {
    const loaded = await fixture(true);
    const journal = new RootJournal();

    await expect(executeDurableAuthoredFlow(
      loaded, journal as unknown as JournalClient, undefined,
      { dataDir: '/unused', admissionKey: 'failure' },
    )).rejects.toThrow('child failed');
    expect(journal.peer.completions).toEqual(Array.from({ length: 8 }, (_, index) => ({
      attempt: index + 1, reason: 'worker_error',
    })));
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

async function fixture(fails = false, delayMs = 0): Promise<LoadedAuthoredFlow> {
  const directory = await mkdtemp(join(tmpdir(), 'authored-root-'));
  directories.push(directory);
  const sourcePath = join(directory, 'flagship.flow.ts');
  await writeFile(sourcePath, 'export default "exact source";\n');
  const handle = fails
    ? flow('flagship', async () => { throw new Error('child failed'); })
    : flow('flagship', async f => {
      if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
      f.done('success');
    });
  const getDefinition = getFlowDefinition as LoadedAuthoredFlow['getDefinition'];
  return {
    sourcePath, handle, getDefinition, surfaceAuthority: surface,
    graph: [{ path: sourcePath, handle, getDefinition, surfaceAuthority: surface, use: [] }],
  };
}

function dispatch(runId: string, attempt: number): StepDispatchEvent {
  return {
    run_id: runId, step_id: 'authored-root', attempt, step_type: 'agent', spec: {},
    lease_id: `lease-${attempt}`, idempotency_key: `key-${attempt}`,
    lease_deadline_ms: Date.now() + 30,
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

function completedEntry(): Record<string, unknown> {
  return {
    entry_type: 'step.completed', step_id: 'authored-root',
    payload: { completionReason: 'success', output: {
      name: 'flagship', completionReason: 'success', journalSteps: [],
    } },
  };
}
