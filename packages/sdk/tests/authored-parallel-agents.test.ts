import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { flow } from '@relayflows/surface';
import { AuthoredFlowExecutionError, executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { attachLocalAgent } from '../src/local-agent.js';
import { JournalClient } from '../src/journal-client.js';
import { LlmWorker } from '../src/llm-worker.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { chainFixture } from './flow-chain-fixture.js';

const closes: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});

/** The fixture's wrapper, but each session holds for a while and journals when it ran. */
async function slowAgents(capacity: number) {
  const fixture = chainFixture();
  closes.push(() => fixture.close());
  const spans = join(fixture.root, 'spans.jsonl');
  writeFileSync(fixture.wrapper, `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(resolve('../../testdata/preflight/wrapper-session.mjs'))};
import { appendFileSync } from 'node:fs';
if (process.argv[2] === 'auth') process.exit(0);
const request = await receiveWrapperRequest();
if (request) {
  const start = Date.now();
  await new Promise(done => setTimeout(done, 400));
  appendFileSync(${JSON.stringify(spans)}, JSON.stringify({ start, end: Date.now() }) + '\\n');
  process.stdout.write('done');
}
`);
  const client = await fixture.connect();
  const agent = await attachLocalAgent(client, undefined, undefined, undefined, capacity);
  closes.push(() => agent.close());
  // One worker registration per session, so the LLM worker gets its own connection.
  const llmClient = new JournalClient(socketPathFor(fixture.data));
  await llmClient.connect();
  await llmClient.hello('parallel-llm-worker');
  closes.push(async () => { llmClient.close(); });
  const llm = new LlmWorker(llmClient, `${agent.stream}-llm`, capacity);
  await llm.attach();
  closes.push(() => llm.close());
  const readSpans = () => readFileSync(spans, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line) as { start: number; end: number });
  return { fixture, client, agent, readSpans };
}

function peakOverlap(spans: Array<{ start: number; end: number }>): number {
  return Math.max(...spans.map(({ start }) => spans.filter(other => other.start <= start && start < other.end).length));
}

const threeReviewers = flow('three-reviewers', async f => {
  await Promise.all(['a', 'b', 'c'].map(lens => f.agent(`review-${lens}`, { task: `Review for ${lens}` })));
  f.done('success');
});

const threeSummaries = flow('three-summaries', async f => {
  await Promise.all(['a', 'b', 'c'].map(topic => f.llm`Summarize ${topic}`));
  f.done('success');
});

describe('authored steps under local workers with capacity', () => {
  it('runs more concurrent f.llm calls than the worker holds side by side, never more than its capacity', async () => {
    const { fixture, client, agent, readSpans } = await slowAgents(2);
    const result = await executeAuthoredFlow(threeSummaries, client, undefined, {
      flowPath: fixture.flowPath, localAgentStream: agent.stream, workerCapacity: 2,
    });
    expect(result.completionReason).toBe('success');
    expect(result.journalSteps.filter(step => step.id.startsWith('llm-'))).toHaveLength(3);
    expect(peakOverlap(readSpans())).toBe(2);
  });

  it('completes more concurrent f.agent calls than the worker holds: the overflow waits for a slot instead of parking', async () => {
    const { fixture, client, agent } = await slowAgents(2);
    const result = await executeAuthoredFlow(threeReviewers, client, undefined, {
      flowPath: fixture.flowPath, localAgentStream: agent.stream, workerCapacity: 2,
    });
    expect(result.completionReason).toBe('success');
    expect(result.journalSteps.filter(step => step.id.startsWith('agent-'))).toHaveLength(3);
    // No overlap is asserted: agents sharing a working directory still take
    // turns for artifact attribution (worker-cli.ts serializedByDirectory).
  });

  it('runs agents in distinct working directories side by side (the kernel carries cwd)', async () => {
    const { fixture, client, agent, readSpans } = await slowAgents(2);
    const trees = ['a', 'b'].map(name => join(fixture.root, 'trees', name));
    for (const tree of trees) mkdirSync(tree, { recursive: true });
    const inTrees = flow('two-trees', async f => {
      await Promise.all(trees.map((cwd, index) => f.agent(`tree-${index}`, { task: 'work here', cwd })));
      f.done('success');
    });
    const result = await executeAuthoredFlow(inTrees, client, undefined, {
      flowPath: fixture.flowPath, localAgentStream: agent.stream, workerCapacity: 2,
    });
    expect(result.completionReason).toBe('success');
    expect(peakOverlap(readSpans())).toBe(2);
  });

  it('parks the overflow when the body is not told the capacity (the defect this closes)', async () => {
    const { fixture, client, agent } = await slowAgents(1);
    const run = executeAuthoredFlow(threeReviewers, client, undefined, {
      flowPath: fixture.flowPath, localAgentStream: agent.stream,
    });
    await expect(run).rejects.toSatisfy(error =>
      error instanceof AuthoredFlowExecutionError && error.code === 'agent_parked');
  });
});
