import { execFileSync } from 'node:child_process';
import { availableParallelism } from 'node:os';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { toKernelSpec } from '../src/compile.js';
import { JournalClient } from '../src/journal-client.js';
import { chainFixture, shellWord } from './flow-chain-fixture.js';

it('completes a CPU-saturating deterministic flow with reads in flight and preserves its journal', async () => {
  const fixture = chainFixture();
  const primary = await fixture.connect();
  const client = new JournalClient(primary.socketPath, { requestTimeoutMs: 100, readBudgetMs: 15_000 });
  let processors = availableParallelism();
  if (process.platform === 'linux') {
    // Saturate the daemon's entire CPU allocation without starving unrelated
    // test fixtures whose synthetic worker leases last only 30 milliseconds.
    const cpu = readFileSync('/proc/self/status', 'utf8').match(/^Cpus_allowed_list:\s*(\d+)/m)![1]!;
    const { pid } = JSON.parse(readFileSync(join(fixture.data, 'connection.json'), 'utf8'));
    execFileSync('taskset', ['-apc', cpu, String(pid)]);
    processors = 1;
  }
  const stamp = join(fixture.root, 'effects');
  let started!: (runId: string) => void;
  const admitted = new Promise<string>(resolve => { started = resolve; });
  client.on('entry', entry => { if (entry.entry_type === 'run.spawned') started(entry.run_id); });
  // One runnable CPU burner per available processor, launched by the flow itself.
  // The shell trap owns all burners even if the deterministic step is terminated.
  const command = `pids=''; trap 'kill $pids 2>/dev/null; wait' EXIT; `
    + `i=0; while [ "$i" -lt ${processors} ]; do yes >/dev/null & pids="$pids $!"; i=$((i+1)); done; sleep 2`;
  try {
    await client.connect();
    await client.hello('load-regression');
    const execution = client.runStart(toKernelSpec({ version: '0.1.0', name: 'read-under-load', steps: [
      { id: 'saved', type: 'deterministic', command: `echo saved >> ${shellWord(stamp)}` },
      { id: 'cpu', type: 'deterministic', command, dependsOn: ['saved'] },
      { id: 'after', type: 'deterministic', command: 'echo survived', dependsOn: ['cpu'] },
    ] }), undefined, undefined, true);
    const runId = await admitted;
    const reads = Promise.all(Array.from({ length: 8 }, () => client.runGet(runId)));
    const [outcome, snapshots] = await Promise.all([execution, reads]);
    expect(outcome).toMatchObject({ status: 'completed', completion_reason: 'success', completed_steps: 3 });
    expect(snapshots.every(snapshot => snapshot.run_id === runId)).toBe(true);
    const entries = (await client.journalRead(runId, 1, 1000)).entries as Array<{ entry_type: string }>;
    expect(entries.filter(entry => entry.entry_type === 'step.completed')).toHaveLength(3);
    expect(await client.runResume(runId)).toMatchObject({ status: 'completed', completion_reason: 'success' });
    expect(readFileSync(stamp, 'utf8')).toBe('saved\n');
  } finally { client.close(); await fixture.close(); }
}, 30_000);

it('drains read and watch promises before an authored flow completes', async () => {
  const { flow } = await import('@relayflows/surface');
  const { executeAuthoredFlow } = await import('../src/authored-flow-executor.js');
  const { LlmWorker } = await import('../src/llm-worker.js');
  const fixture = chainFixture();
  const workerClient = await fixture.connect();
  const worker = new LlmWorker(workerClient, 'read-policy-worker');
  const client = new JournalClient(workerClient.socketPath, { readBudgetMs: 5_000 });
  try {
    await client.connect();
    await worker.attach();
    const result = await executeAuthoredFlow(flow('read-policy-scope', async f => {
      await f.llm('hello', { model: 'test-model', output: { type: 'object' } });
      f.done('success');
    }), client, undefined, { flowPath: fixture.flowPath });
    expect(result.completionReason).toBe('success');
  } finally { await worker.close(); client.close(); await fixture.close(); }
}, 30_000);
