import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { flow } from '@relayflows/surface';
import { executeAuthoredFlow } from '../src/authored-flow-executor.js';
import { checkAuthoredFlow } from '../src/cli/check.js';
import { JournalClient } from '../src/journal-client.js';
import { LlmWorker } from '../src/llm-worker.js';
import { socketPathFor } from '../src/daemon-connection.js';
import { SPEC_SCHEMA_VERSION } from '../src/spec.js';
import { chainFixture } from './flow-chain-fixture.js';

// F9 for #421: preflight warning -> worker usage -> kernel enforcement, through
// the real kernel binary. Unpriced steps journal tokens as dollar-unmetered and
// never trip a dollar budget; their tokens still trip a token budget; priced
// steps still accrue dollars and a real overrun still stops the run.

const schema = { type: 'object', required: ['message'], properties: { message: { type: 'string' } } };
const closes: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of closes.splice(0).reverse()) await close(); });

/** The fixture wrapper reports 500 input / 500 output tokens for an unpriced model. */
const unpricedEnvelope = JSON.stringify({
  protocol: 'relayflows-agent-cli-v1-result', output: { message: 'answer' }, usage: { input_tokens: 500, output_tokens: 500 },
});

async function setup() {
  const fixture = chainFixture(unpricedEnvelope);
  closes.push(() => fixture.close());
  const client = await fixture.connect();
  const llmClient = new JournalClient(socketPathFor(fixture.data));
  await llmClient.connect();
  await llmClient.hello('budget-unmetered-llm');
  closes.push(async () => { llmClient.close(); });
  const llm = new LlmWorker(llmClient, 'budget-unmetered-llm');
  const failures: unknown[] = [];
  llm.on('error', error => failures.push(error));
  await llm.attach();
  closes.push(() => llm.close());
  return { fixture, client, failures };
}

type Entry = { entry_type: string; step_id: string | null; payload: Record<string, any> };
async function entries(client: JournalClient, runId: string): Promise<Entry[]> {
  return (await client.journalRead(runId, 1)).entries as Entry[];
}

describe('unmetered budget spend through the live kernel', () => {
  it('runs an unpriced step under a dollar budget without tripping it, journaling unknown dollars', async () => {
    const { fixture, client, failures } = await setup();
    const checked = checkAuthoredFlow({
      version: SPEC_SCHEMA_VERSION, name: 'unmetered/check', budget: '$0.000001/run',
      steps: [{ id: 'ask', type: 'llm', prompt: 'Answer.', model: 'test-model', output: schema }],
    }, fixture.flowPath);
    expect(checked.report.ok).toBe(true);
    expect(checked.report.diagnostics).toEqual([expect.objectContaining({ severity: 'warning', kind: 'budget_unmetered', stepId: 'ask' })]);

    const handle = flow('unmetered-dollars', { budget: '$0.000001/run' }, async f => {
      expect(await f.llm('Answer.', { output: schema, model: 'test-model' })).toEqual({ message: 'answer' });
      await f.run('printf after-unmetered');
      f.done('success');
    });
    const result = await executeAuthoredFlow(handle, client, undefined, { flowPath: fixture.flowPath });
    expect(result.completionReason).toBe('success');
    expect(result.journalSteps.map(step => step.id)).toEqual(['llm-1', 'run-2', 'complete-3']);

    const llmRun = await entries(client, result.journalSteps[0]!.runId);
    const completed = llmRun.find(e => e.entry_type === 'step.completed')!;
    expect(completed.payload.completionReason).toBe('success');
    expect(completed.payload.budget).toEqual({ tokens_in: 500, tokens_out: 500, dollars: '0', dollars_unmetered: true });
    expect(completed.payload.spend).toMatchObject({ tokens_input: 500, tokens_output: 500, dollars: 0, dollars_unmetered: true });
    expect(llmRun.find(e => e.entry_type === 'run.completed')!.payload.budget_total).toMatchObject({ dollars_unmetered: true });
    expect(failures).toEqual([]);
  });

  it('still counts an unpriced step toward a token budget', async () => {
    const { fixture, client, failures } = await setup();
    const handle = flow('unmetered-tokens', { budget: { tokens: 100, dollars: 1 } }, async f => {
      await f.llm('Answer.', { output: schema, model: 'test-model' });
      await f.run('printf must-not-run');
      f.done('success');
    });
    await expect(executeAuthoredFlow(handle, client, undefined, { flowPath: fixture.flowPath }))
      .rejects.toMatchObject({ completionReason: 'budget_exceeded' });
    expect(failures).toEqual([]);
  });

  it('accrues a priced step and stops the run when it crosses the dollar budget', async () => {
    const { fixture, client, failures } = await setup();
    const claude = join(fixture.root, 'claude');
    writeFileSync(join(fixture.root, 'flows.json'), JSON.stringify({ models: ['claude-opus-5'] }));
    writeFileSync(claude, `#!/usr/bin/env node
if (process.argv[2] === 'auth') process.exit(0);
if (process.argv.includes('Reply with exactly RELAYFLOWS_MODEL_READY and nothing else.')) {
  process.stdout.write('RELAYFLOWS_MODEL_READY\\n'); process.exit(0);
}
process.stdout.write(JSON.stringify({ type: 'result', result: JSON.stringify({ message: 'priced-ok' }), usage: { input_tokens: 2, output_tokens: 1 } }) + '\\n');
`);
    chmodSync(claude, 0o755);
    const runIds: string[] = [];
    const handle = flow('priced-dollars', { budget: '$0.000001/run' }, async f => {
      expect(await f.llm('Answer.', { output: schema, cli: claude, model: 'claude-opus-5' })).toEqual({ message: 'priced-ok' });
      await f.run('printf must-not-run');
      f.done('success');
    });
    const start = client.runStart.bind(client);
    client.runStart = (async (...args: Parameters<JournalClient['runStart']>) => {
      const outcome = await start(...args);
      runIds.push(outcome.run_id);
      return outcome;
    }) as JournalClient['runStart'];
    await expect(executeAuthoredFlow(handle, client, undefined, { flowPath: fixture.flowPath }))
      .rejects.toMatchObject({ completionReason: 'budget_exceeded' });

    const completed = (await entries(client, runIds[0]!)).find(e => e.entry_type === 'step.completed')!;
    // claude-opus-5: 2 * $5/M + 1 * $25/M = $0.000035.
    expect(completed.payload.budget).toEqual({ tokens_in: 2, tokens_out: 1, dollars: '0.000035' });
    expect(completed.payload.spend).not.toHaveProperty('dollars_unmetered');
    const refused = await entries(client, runIds[1]!);
    expect(refused).toEqual(expect.arrayContaining([expect.objectContaining({
      entry_type: 'run.completed', payload: expect.objectContaining({ completionReason: 'budget_exceeded' }),
    })]));
    expect(refused.some(e => e.entry_type === 'step.attempt.started')).toBe(false);
    expect(failures).toEqual([]);
  });
});
