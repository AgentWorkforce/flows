import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { decodeProviderResult, decodeWrapperResult, requirePricedUsage } from '../src/worker-usage.js';
import { pricedUsage, MODEL_PRICING } from '../src/model-pricing.js';
import { AuthoredBudget } from '../src/authored-budget.js';
import type { JournalClient } from '../src/journal-client.js';
import type { StepDispatchEvent } from '../src/protocol.js';
import { LlmWorker } from '../src/llm-worker.js';

vi.mock('../src/worker-cli.js', () => ({runAgentCli: vi.fn(async () => ({exit_code: 0, stdout_tail: 'answer', stderr_tail: '', tokens_input: 1000, tokens_output: 200}))}));
vi.mock('../src/worker-lease.js', () => ({withWorkerLease: (_c: unknown, _d: unknown, run: (s: AbortSignal) => unknown) => run(new AbortController().signal)}));

describe('budget attribution', () => {
  it('threads mocked provider tokens through the worker completion', async () => {
    const client = Object.assign(new EventEmitter(), {workerAttach: vi.fn(), stepComplete: vi.fn()});
    const worker = new LlmWorker(client as unknown as JournalClient, 'test');
    await worker.attach();
    client.emit('step.dispatch', {run_id:'r', step_id:'s', step_type:'llm', attempt:1, idempotency_key:'k',
      spec:{type:'llm', prompt:'hello', cli:'claude', model:'claude-sonnet-4-6'}} as StepDispatchEvent);
    await worker.close();
    expect(client.stepComplete.mock.calls[0]?.[5]).toMatchObject({output:'answer', usage:{tokens_in:1000, tokens_out:200, dollars:'0.006000'}});
  });
  it('extracts provider usage while preserving the authored output', () => {
    for (const [kind, stdout] of [
      ['claude', JSON.stringify({type:'result', result:'answer', usage:{input_tokens:1000, output_tokens:200}})],
      ['codex', [JSON.stringify({type:'item.completed', item:{type:'agent_message', text:'answer'}}), JSON.stringify({type:'turn.completed', usage:{input_tokens:1000, output_tokens:200}})].join('\n')],
    ] as const) {
      const result = decodeProviderResult({exit_code:0, stdout_tail:stdout, stderr_tail:''}, kind);
      expect(result).toMatchObject({stdout_tail:'answer', tokens_input:1000, tokens_output:200});
      expect(pricedUsage('claude-sonnet-4-6', result.tokens_input, result.tokens_output).dollars).toBe('0.006000');
    }
    expect(Object.isFrozen(MODEL_PRICING)).toBe(true);
    expect(Object.isFrozen(MODEL_PRICING['codex-large'])).toBe(true);
  });
  it('accepts explicit wrapper usage and refuses missing or malformed priced usage', () => {
    const base = {exit_code: 0, stdout_tail: 'answer', stderr_tail: ''};
    expect(requirePricedUsage(base, 'codex-medium').exit_code).toBeNull();
    expect(decodeWrapperResult({...base, stdout_tail: JSON.stringify({protocol:'relayflows-agent-cli-v1-result', usage:{input_tokens:5, output_tokens:2}})}).exit_code).toBeNull();
    const wrapped = decodeWrapperResult({...base, stdout_tail: JSON.stringify({protocol:'relayflows-agent-cli-v1-result', output:'answer', usage:{input_tokens:5, output_tokens:2}})});
    expect(requirePricedUsage(wrapped, 'codex-medium')).toMatchObject({exit_code:0, stdout_tail:'answer', tokens_input:5, tokens_output:2});
    expect(decodeProviderResult({...base, stdout_tail: JSON.stringify({type:'result', result:'answer', usage:{input_tokens:-1, output_tokens:2}})}, 'claude').exit_code).toBeNull();
  });
  it('carries exact completed spend into the next authored step kernel run', async () => {
    const budget = new AuthoredBudget('$0.001/run');
    const client = {runStart: vi.fn(async () => ({run_id:'r', status:'completed', completion_reason:'success', completed_steps:1})),
      journalRead: vi.fn(async (_run: string, seq: number) => ({entries: seq === 1 ? [{seq:1, entry_type:'step.completed', at_ms:0,
        payload:{budget:{tokens_in:1000, tokens_out:200, dollars:'0.006000'}, spend:{wallclock_ms:25}}}] : []}))};
    const spec = {version:'0.1.0', steps:[]};
    await budget.execute(client as unknown as JournalClient, spec, async () => 'answer');
    await budget.execute(client as unknown as JournalClient, spec, async () => 'answer');
    expect((client.runStart.mock.calls as unknown as [{budget:unknown}][])[1]?.[0].budget).toMatchObject({max_dollars:'0.001', prior_spend:{tokens_in:1000, tokens_out:200, dollars:'0.006000', wallclock_ms:25}});
  });
});
