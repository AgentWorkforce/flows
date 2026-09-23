import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { flow } from '@relayflows/surface';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { attachLocalAgent } from '../src/local-agent.js';
import { JournalClient } from '../src/journal-client.js';
import { LlmWorker } from '../src/llm-worker.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { chainFixture } from './flow-chain-fixture.js';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

const PROBE_MS = Number(process.env['SCRATCH_PROBE_MS'] ?? '4000');
const N = Number(process.env['SCRATCH_N'] ?? '9');

async function fixtureWithSlowProbe(capacity: number) {
  const fixture = chainFixture();
  closes.push(() => fixture.close());
  const probes = join(fixture.root, 'probes.jsonl');
  writeFileSync(fixture.wrapper, `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(resolve('../../testdata/preflight/wrapper-session.mjs'))};
import { appendFileSync } from 'node:fs';
if (process.argv[2] === 'auth') {
  appendFileSync(${JSON.stringify(probes)}, JSON.stringify({ kind: 'auth', at: Date.now() }) + '\\n');
  await new Promise(r => setTimeout(r, ${PROBE_MS}));
  process.exit(0);
}
if (process.argv[2] === '--relayflows-adapter-v1') {
  appendFileSync(${JSON.stringify(probes)}, JSON.stringify({ kind: 'identify', at: Date.now() }) + '\\n');
}
const request = await receiveWrapperRequest();
if (request) process.stdout.write('ok');
`);
  const client = await fixture.connect();
  const agent = await attachLocalAgent(client, undefined, undefined, undefined, capacity);
  closes.push(() => agent.close());
  const llmClient = new JournalClient(socketPathFor(fixture.data));
  await llmClient.connect();
  await llmClient.hello('scratch-llm-worker');
  closes.push(async () => { llmClient.close(); });
  const llm = new LlmWorker(llmClient, `${agent.stream}-llm`, capacity);
  await llm.attach();
  closes.push(() => llm.close());
  const readProbes = () => (existsSync(probes) ? readFileSync(probes, 'utf8').trim().split('\n')
    .filter(Boolean).map(l => JSON.parse(l) as { kind: string; at: number }) : []);
  return { fixture, client, agent, readProbes };
}

const many = flow('many-summaries', async f => {
  await Promise.all(Array.from({ length: N }, (_, i) => f.llm`Summarize ${String(i)}`));
  f.done('success');
});

describe('scratch: repeated per-call preflight probes', () => {
  it(`runs ${N} concurrent f.llm at capacity 1`, async () => {
    const CAP = Number(process.env['SCRATCH_CAP'] ?? '1');
    const { fixture, client, agent, readProbes } = await fixtureWithSlowProbe(CAP);
    let failure: unknown;
    const started = Date.now();
    let result: Awaited<ReturnType<typeof executeAuthoredFlow>> | undefined;
    try {
      result = await executeAuthoredFlow(many, client, undefined, {
        flowPath: fixture.flowPath, localAgentStream: agent.stream, workerCapacity: CAP,
      });
    } catch (error) { failure = error; }
    const elapsed = Date.now() - started;
    const probes = readProbes();
    // eslint-disable-next-line no-console
    console.log(JSON.stringify({
      elapsedMs: elapsed,
      probeCount: probes.length,
      byKind: probes.reduce((acc, p) => ({ ...acc, [p.kind]: (acc[p.kind] ?? 0) + 1 }), {} as Record<string, number>),
      failure: failure instanceof Error ? failure.message : failure,
      completionReason: result?.completionReason,
    }, null, 2));

    // Scan every child run journal for a lease_expired attempt.
    const runIds = (result?.journalSteps ?? []).map(s => s.runId);
    const expired: string[] = [];
    for (const runId of runIds) {
      const { entries } = await client.journalRead(runId, 1, 500);
      for (const raw of entries as Array<{ entry_type: string; step_id?: string; payload?: { completionReason?: string } }>) {
        if (raw.entry_type === 'step.completed' && raw.payload?.completionReason === 'lease_expired') {
          expired.push(`${runId}/${raw.step_id}`);
        }
      }
    }
    // eslint-disable-next-line no-console
    console.log('lease_expired attempts: ' + JSON.stringify(expired));
    expect(true).toBe(true);
  }, 300_000);
});
