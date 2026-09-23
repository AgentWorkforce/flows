import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
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
async function slowAgents(capacity: number, failFirstSession = false) {
  const fixture = chainFixture();
  closes.push(() => fixture.close());
  const spans = join(fixture.root, 'spans.jsonl');
  writeFileSync(fixture.wrapper, `#!/usr/bin/env node
import { receiveWrapperRequest } from ${JSON.stringify(resolve('../../testdata/preflight/wrapper-session.mjs'))};
import { appendFileSync, existsSync, writeFileSync } from 'node:fs';
if (process.argv[2] === 'auth') process.exit(0);
const request = await receiveWrapperRequest();
if (request) {
  const start = Date.now();
  await new Promise(done => setTimeout(done, 400));
  appendFileSync(${JSON.stringify(spans)}, JSON.stringify({ start, end: Date.now() }) + '\\n');
  ${failFirstSession ? `if (!existsSync(${JSON.stringify(join(fixture.root, 'failed-once'))})) {
    writeFileSync(${JSON.stringify(join(fixture.root, 'failed-once'))}, '');
    process.exit(1);
  }` : ''}
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
    // They share this package's directory, so each snapshot walks it: allow time.
  }, 20_000);

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

  // A snapshot walks the whole tree, so a symlink alias of the same directory,
  // or a directory nested inside another agent's, must still take turns.
  it.each([
    ['a symlink alias of the same directory', (tree: string, root: string) => {
      const link = join(root, 'alias');
      symlinkSync(tree, link);
      return link;
    }],
    ['a directory nested inside the other', (tree: string) => {
      const nested = join(tree, '.wt', 'inner');
      mkdirSync(nested, { recursive: true });
      return nested;
    }],
  ])('serializes agents whose cwd is %s', async (_case, second) => {
    const { fixture, client, agent, readSpans } = await slowAgents(2);
    const tree = join(fixture.root, 'trees', 'shared');
    mkdirSync(tree, { recursive: true });
    const trees = [tree, second(tree, fixture.root)];
    const overlapping = flow('overlapping-trees', async f => {
      await Promise.all(trees.map((cwd, index) => f.agent(`tree-${index}`, { task: 'work here', cwd })));
      f.done('success');
    });
    const result = await executeAuthoredFlow(overlapping, client, undefined, {
      flowPath: fixture.flowPath, localAgentStream: agent.stream, workerCapacity: 2,
    });
    expect(result.completionReason).toBe('success');
    expect(peakOverlap(readSpans())).toBe(1);
  });

  it('never starts queued agents once the body has failed', async () => {
    const { fixture, client, agent, readSpans } = await slowAgents(1);
    const failing = flow('fails-while-queued', async f => {
      await Promise.all([
        ...['a', 'b', 'c'].map(lens => f.agent(`review-${lens}`, { task: `Review for ${lens}` })),
        new Promise((_, reject) => setTimeout(() => reject(new Error('body failed')), 100)),
      ]);
      f.done('success');
    });
    await expect(executeAuthoredFlow(failing, client, undefined, {
      flowPath: fixture.flowPath, localAgentStream: agent.stream, workerCapacity: 1,
    })).rejects.toThrow('body failed');
    // Teardown waits for the one agent already holding the slot; the two
    // queued behind it are refused, not admitted after the flow has failed.
    await new Promise(done => setTimeout(done, 1_000));
    expect(readSpans()).toHaveLength(1);
  });

  // #554 (Cursor): the holder's own failure fails the body; the next queued
  // agent must not be handed the slot before teardown refuses it.
  it('never starts a queued agent when the agent holding the only slot fails', async () => {
    const { fixture, client, agent, readSpans } = await slowAgents(1, true);
    await expect(executeAuthoredFlow(threeReviewers, client, undefined, {
      flowPath: fixture.flowPath, localAgentStream: agent.stream, workerCapacity: 1,
    })).rejects.toBeDefined();
    await new Promise(done => setTimeout(done, 1_000));
    expect(readSpans()).toHaveLength(1);
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
