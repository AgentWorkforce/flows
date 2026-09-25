import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { flow } from '@relayflows/surface';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { executeDurableAuthoredFlow } from '../src/authored-root.js';
import { loadAuthoredFlow } from '../src/authored-flow-loader.js';
import { LlmWorker } from '../src/llm-worker.js';
import { DEFAULT_LOCAL_AGENT_CAPACITY } from '../src/worker-slots.js';
import { chainFixture } from './flow-chain-fixture.js';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

async function setup(capacity: number, probeDelayMs: number) {
  const fixture = chainFixture();
  closes.push(() => fixture.close());
  const probes = join(fixture.root, 'probes.jsonl');
  const spans = join(fixture.root, 'spans.jsonl');
  writeFileSync(probes, '');
  writeFileSync(spans, '');
  writeFileSync(join(fixture.root, 'flows.json'),
    JSON.stringify({ cli: fixture.wrapper, models: ['test-model', 'second-model'] }));
  writeFileSync(fixture.wrapper, `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(resolve('../../testdata/preflight/wrapper-session.mjs'))};
import { appendFileSync } from 'node:fs';
if (process.argv[2] === 'auth') {
  appendFileSync(${JSON.stringify(probes)}, JSON.stringify(process.env.RELAYFLOW_MODEL) + '\\n');
  await new Promise(done => setTimeout(done, ${probeDelayMs}));
  process.exit(0);
}
const request = await receiveWrapperRequest();
if (request) {
  const start = Date.now();
  await new Promise(done => setTimeout(done, 150));
  appendFileSync(${JSON.stringify(spans)}, JSON.stringify({ start, end: Date.now() }) + '\\n');
  process.stdout.write('{"x":1}');
}
`);
  const client = await fixture.connect();
  const peer = client.createPeer();
  await peer.connect();
  await peer.hello('parallel-llm-regression');
  closes.push(async () => { peer.close(); });
  const worker = new LlmWorker(peer, 'parallel-llm', capacity);
  await worker.attach();
  closes.push(() => worker.close());
  const lines = (path: string) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
  async function assertJournals(expected: number) {
    const ids = readdirSync(join(fixture.data, 'runs')).filter(name => name.endsWith('.sqlite3'));
    expect(ids).toHaveLength(expected);
    const expired: unknown[] = [];
    for (const name of ids) {
      const { entries } = await client.journalRead(name.slice(0, -8), 1, 500);
      expired.push(...entries.filter(entry => entry.entry_type === 'step.completed'
        && (entry.payload as { completionReason?: string })?.completionReason === 'lease_expired'));
    }
    expect(expired).toEqual([]);
  }
  return { fixture, client, assertJournals, assertProbes(count: number) {
    expect(lines(probes)).toHaveLength(count);
  }, assertCapacity() {
    const intervals = lines(spans) as Array<{ start: number; end: number }>;
    expect(intervals).toHaveLength(9);
    const peak = Math.max(...intervals.map(({ start }) =>
      intervals.filter(other => other.start <= start && start < other.end).length));
    expect(peak).toBeLessThanOrEqual(capacity);
    expect(peak).toBeGreaterThan(0);
  } };
}

const output = { type: 'object', properties: { x: { type: 'number' } }, required: ['x'], additionalProperties: false };
const many = flow('parallel-llm', async f => {
  await Promise.all(Array.from({ length: 9 }, (_, i) =>
    f.llm(`Return {"x": ${i}+1} as JSON only.`, { output, model: 'test-model' })));
  f.done('success');
});

describe.each([1, DEFAULT_LOCAL_AGENT_CAPACITY])('parallel llm capacity %i', capacity => {
  it('deduplicates concurrent preflight probes', async () => {
    const test = await setup(capacity, 0);
    const result = await executeAuthoredFlow(many, test.client, undefined, {
      flowPath: test.fixture.flowPath, workerCapacity: capacity,
    });
    expect(result.completionReason).toBe('success');
    test.assertProbes(1);
    test.assertCapacity();
    await test.assertJournals(10);
  }, 120_000);

  it('completes nine calls without expired child leases during slow preflight', async () => {
    // Before the fix, eight remaining probes block dispatch for 48 s (>30 s).
    const test = await setup(capacity, 6_000);
    const result = await executeAuthoredFlow(many, test.client, undefined, {
      flowPath: test.fixture.flowPath, workerCapacity: capacity,
    });
    await test.assertJournals(10);
    expect(result.completionReason).toBe('success');
    test.assertProbes(1);
    test.assertCapacity();
  }, 120_000);

  it('keeps the durable root lease alive across two cold models', async () => {
    // A single cold probe exceeds the root's 30 s lease. Cache alone cannot
    // rescue this; the process must keep handling heartbeats while probing.
    const test = await setup(capacity, 45_000);
    writeFileSync(test.fixture.flowPath, `
import { flow } from '@relayflows/surface';
export default flow('two-models', async f => {
  await Promise.all(Array.from({ length: 9 }, (_, i) =>
    f.llm('Return {"x":1}', { output: ${JSON.stringify(output)}, model: i % 2 ? 'second-model' : 'test-model' })));
  f.done('success');
});
`);
    const loaded = await loadAuthoredFlow(test.fixture.flowPath);
    const result = await executeDurableAuthoredFlow(loaded, test.client, undefined, {
      dataDir: test.fixture.data, workerCapacity: capacity,
    });
    await test.assertJournals(11);
    expect(result.completionReason).toBe('success');
    test.assertProbes(2);
    test.assertCapacity();
  }, 120_000);
});
