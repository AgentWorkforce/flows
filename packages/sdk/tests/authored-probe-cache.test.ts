import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { flow } from '@relayflows/surface';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { attachLocalAgent } from '../src/local-agent.js';
import { JournalClient } from '../src/journal-client.js';
import { LlmWorker } from '../src/llm-worker.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { onWorkerFailure } from '../src/worker-lease.js';
import { DEFAULT_LOCAL_AGENT_CAPACITY } from '../src/worker-slots.js';
import { chainFixture } from './flow-chain-fixture.js';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});

async function slowProbe(capacity: number, probeMs: number, fail = false) {
  const fixture = chainFixture();
  closes.push(() => fixture.close());
  const log = join(fixture.root, 'probes.jsonl');
  writeFileSync(fixture.wrapper, `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(resolve('../../testdata/preflight/wrapper-session.mjs'))};
import { appendFileSync } from 'node:fs';
const log = value => appendFileSync(${JSON.stringify(log)}, JSON.stringify(value) + '\\n');
if (process.argv[2] === 'auth') {
  log({ kind: 'auth' });
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ${probeMs});
  ${fail ? "process.kill(process.pid, 'SIGTERM');" : 'process.exit(0);'}
}
// Identify-only probes exit inside receiveWrapperRequest; executions also
// identify, so subtract the recorded sessions to count preflight probes.
log({ kind: 'identify' });
const request = await receiveWrapperRequest();
if (request) {
  const start = Date.now();
  await new Promise(done => setTimeout(done, 200));
  log({ kind: 'session', start, end: Date.now() });
  process.stdout.write('{"x":4}');
}
`);
  const client = await fixture.connect();
  const agent = await attachLocalAgent(client, undefined, undefined, undefined, capacity, fixture.root);
  closes.push(() => agent.close());
  const llmClient = new JournalClient(socketPathFor(fixture.data));
  await llmClient.connect();
  await llmClient.hello('probe-cache-llm');
  closes.push(async () => { llmClient.close(); });
  const worker = new LlmWorker(llmClient, `${agent.stream}-llm`, capacity);
  const failures: unknown[] = [];
  worker.on('error', onWorkerFailure('test-llm', error => { failures.push(error); client.close(); }));
  await worker.attach();
  closes.push(() => worker.close());
  const logs = () => readFileSync(log, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { kind: string; start: number; end: number });
  return { fixture, client, agent, failures, logs,
    options: { flowPath: fixture.flowPath, localAgentStream: agent.stream, workerCapacity: capacity } };
}

const nine = flow('nine-llms', async f => {
  const xs = await Promise.all(Array.from({ length: 9 }, (_, i) => f.llm(`Return JSON for ${i}`, {
    output: { type: 'object', properties: { x: { type: 'number' } }, required: ['x'] }, model: 'test-model',
  })));
  expect(xs).toEqual(Array.from({ length: 9 }, () => ({ x: 4 })));
  f.done('success');
});

function expectOneProbe(logs: ReturnType<Awaited<ReturnType<typeof slowProbe>>['logs']>) {
  expect(logs.filter(l => l.kind === 'auth')).toHaveLength(1);
  expect(logs.filter(l => l.kind === 'identify').length - logs.filter(l => l.kind === 'session').length).toBe(1);
}

describe('authored run CLI probe cache', () => {
  it.each([1, DEFAULT_LOCAL_AGENT_CAPACITY])('nine calls have no expired attempts at capacity %i', async capacity => {
    const { fixture, client, options, failures, logs } = await slowProbe(capacity, 4_000);
    const result = await executeAuthoredFlow(nine, client, undefined, options);
    expect(result.completionReason).toBe('success');
    expect(failures).toEqual([]);
    const runs = readdirSync(join(fixture.data, 'runs')).filter(name => name.endsWith('.sqlite3'));
    expect(runs.length).toBeGreaterThanOrEqual(9);
    for (const file of runs) {
      const { entries } = await client.journalRead(file.slice(0, -8), 1);
      expect(JSON.stringify(entries), file).not.toContain('lease_expired');
      expect(entries.filter(e => e.entry_type === 'step.attempt_started'), file).toHaveLength(1);
    }
    const sessions = logs().filter(l => l.kind === 'session');
    expect(sessions).toHaveLength(9);
    const peak = Math.max(...sessions.map(s => sessions.filter(o => o.start <= s.start && s.start < o.end).length));
    expect(peak).toBeLessThanOrEqual(capacity);
    expectOneProbe(logs());
  }, 120_000);

  it('does not serialize nine starts behind nine probes, and probes again on a new run', async () => {
    const { client, options, logs } = await slowProbe(1, 300);
    const starts: number[] = [];
    await executeAuthoredFlow(nine, client, undefined, { ...options, onProgress: event => {
      if (event.type === 'step.started' && event.stepType === 'llm') starts.push(performance.now());
    } });
    expect(starts).toHaveLength(9);
    // F1 permits one synchronous probe (~300ms), not nine (~3s).
    expect(starts.at(-1)! - starts[0]!).toBeLessThan(450);
    expectOneProbe(logs());
    await executeAuthoredFlow(nine, client, undefined, options);
    expect(logs().filter(l => l.kind === 'auth')).toHaveLength(2);
  }, 20_000);

  it('caches probe failures while refusing all nine calls', async () => {
    const { client, options, logs, fixture } = await slowProbe(1, 300, true);
    const refusals: PromiseSettledResult<unknown>[] = [];
    const failing = flow('failed-probes', async f => {
      refusals.push(...await Promise.allSettled(Array.from({ length: 9 }, () => f.llm`hello`)));
      f.done('success');
    });
    await expect(executeAuthoredFlow(failing, client, undefined, options)).rejects.toThrow('probe');
    expect(refusals).toHaveLength(9);
    for (const refusal of refusals) {
      expect(refusal.status).toBe('rejected');
      if (refusal.status === 'rejected') expect(String(refusal.reason)).toContain('probe');
    }
    expectOneProbe(logs());
    // Refused LLMs never acquired a lease.
    expect(readdirSync(join(fixture.data, 'runs')).filter(n => n.endsWith('.sqlite3'))).toHaveLength(0);
  }, 20_000);

  it('shares probe results across agent calls too', async () => {
    const { client, options, logs, fixture } = await slowProbe(1, 300);
    mkdirSync(join(fixture.root, 'work'));
    const agents = flow('three-agents', async f => {
      await Promise.all(['a', 'b', 'c'].map(name => f.agent(name, { task: 'work', cwd: 'work' })));
      f.done('success');
    });
    expect((await executeAuthoredFlow(agents, client, undefined, options)).completionReason).toBe('success');
    expectOneProbe(logs());
  }, 20_000);
});
