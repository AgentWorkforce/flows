import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { decodeProviderResult, decodeWrapperResult, requirePricedUsage } from '../src/worker-usage.js';
import { pricedUsage, MODEL_PRICING } from '../src/model-pricing.js';
import { AuthoredBudget, budgetExceededMessage } from '../src/authored-budget.js';
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
    const calls = client.runStart.mock.calls as unknown as [{budget:{prior_spend:Record<string, unknown>}}][];
    expect(calls[1]?.[0].budget).toMatchObject({max_dollars:'0.001', prior_spend:{tokens_in:1000, tokens_out:200, dollars:'0.006000', wallclock_ms:25}});
    // A fully metered carry omits the key, so an older kernel sees the payload it always saw.
    expect(calls[1]?.[0].budget.prior_spend).not.toHaveProperty('dollars_unmetered');
  });
  it('carries dollar-unmetered uncertainty into the next authored step kernel run', async () => {
    // An unpriced step journals tokens with no known dollars. Carrying only the
    // numbers made the next run's cumulative total look like a measured zero.
    const budget = new AuthoredBudget('$0.001/run');
    const client = {runStart: vi.fn(async () => ({run_id:'r', status:'completed', completion_reason:'success', completed_steps:1})),
      journalRead: vi.fn(async (_run: string, seq: number) => ({entries: seq === 1 ? [{seq:1, entry_type:'step.completed', at_ms:0,
        payload:{budget:{tokens_in:500, tokens_out:500, dollars:'0', dollars_unmetered:true}, spend:{wallclock_ms:5}}}] : []}))};
    const spec = {version:'0.1.0', steps:[]};
    await budget.execute(client as unknown as JournalClient, spec, async () => 'answer');
    await budget.execute(client as unknown as JournalClient, spec, async () => 'answer');
    const calls = client.runStart.mock.calls as unknown as [{budget:{prior_spend:Record<string, unknown>}}][];
    expect(calls[0]?.[0].budget.prior_spend).not.toHaveProperty('dollars_unmetered');
    expect(calls[1]?.[0].budget.prior_spend).toMatchObject({tokens_in:500, tokens_out:500, dollars:'0.000000', wallclock_ms:5, dollars_unmetered:true});
  });
});

describe('authored budget refusal names the limit it crossed', () => {
  const charge = (payload: Record<string, unknown>) => ({seq: 1, entry_type: 'step.completed', at_ms: 0, payload});
  // The shape of Cloud run f28314ed: 26 steps summed to 132.9 min of step
  // wallclock under `{ wallclock: "2h", dollars: 25 }`, and the refusal said
  // only "Flow budget exceeded before the next step." — not which limit.
  it('reports wallclock used against the declared header on refusal', async () => {
    const budget = new AuthoredBudget({wallclock: '2h', dollars: 25});
    let started = 0;
    const client = {
      runStart: vi.fn(async () => ({run_id: `r${++started}`, status: started === 1 ? 'completed' : 'failed',
        completion_reason: started === 1 ? 'success' : 'budget_exceeded', completed_steps: started === 1 ? 1 : 0})),
      journalRead: vi.fn(async (run: string, seq: number) => ({entries: run === 'r1' && seq === 1
        ? [charge({budget: {tokens_in: 878, tokens_out: 257687, dollars: '6.446600'}, spend: {wallclock_ms: 7_974_000}})] : []})),
    };
    const step = (id: string) => ({version: '0.1.0', steps: [{id}]}) as never;
    await budget.execute(client as unknown as JournalClient, step('agent-26'), async () => 'ok');
    const refused = budget.execute(client as unknown as JournalClient, step('run-27'), async () => 'unreachable');
    await expect(refused).rejects.toMatchObject({
      message: 'step_failed: Flow budget exceeded before step "run-27": wallclock 132.9m used of 2h declared in the flow\'s budget header.',
      code: 'step_failed', completionReason: 'budget_exceeded',
    });
  });
  it('names every crossed dimension, marks unmetered dollars, and scopes a day window', () => {
    const total = {input: 900n, output: 300n, micro: 25_500_000n, ms: 30_000n, unmetered: true};
    expect(budgetExceededMessage({max_dollars: '25', max_tokens: 1000, max_wallclock_ms: 60_000, window: 'day'}, total))
      .toBe("Flow budget exceeded before the next step: dollars $25.50 metered (some steps unmetered) used of $25.00 declared; tokens 1200 used of 1000 declared in today's window of the flow's budget header.");
    expect(budgetExceededMessage({max_tokens_in: 800, max_tokens_out: 300}, total))
      .toBe("Flow budget exceeded before the next step: input tokens 900 used of 800 declared in the flow's budget header.");
  });
  it('prints exact milliseconds when rounding would show a strict overrun as equal (PR #594 review)', () => {
    const zero = {input: 0n, output: 0n, micro: 0n, unmetered: false};
    expect(budgetExceededMessage({max_wallclock_ms: 120_000}, {...zero, ms: 120_001n}))
      .toBe("Flow budget exceeded before the next step: wallclock 120001ms used of 120000ms declared in the flow's budget header.");
    expect(budgetExceededMessage({max_wallclock_ms: 60_000}, {...zero, ms: 60_001n}))
      .toBe("Flow budget exceeded before the next step: wallclock 60001ms used of 60000ms declared in the flow's budget header.");
    // Mixed units: the limit renders in hours, the spend in rounded minutes.
    expect(budgetExceededMessage({max_wallclock_ms: 7_200_000}, {...zero, ms: 7_200_001n}))
      .toBe("Flow budget exceeded before the next step: wallclock 7200001ms used of 7200000ms declared in the flow's budget header.");
    expect(budgetExceededMessage({max_wallclock_ms: 7_200_000}, {...zero, ms: 7_206_000n}))
      .toBe("Flow budget exceeded before the next step: wallclock 120.1m used of 2h declared in the flow's budget header.");
    expect(budgetExceededMessage({max_wallclock_ms: 10}, {...zero, ms: 20n}))
      .toBe("Flow budget exceeded before the next step: wallclock 20ms used of 10ms declared in the flow's budget header.");
  });
  it('names a legacy sub-microdollar dollar limit, compared at its own precision (PR #594 review)', () => {
    const spent = {input: 0n, output: 0n, micro: 1n, ms: 0n, unmetered: false};
    expect(budgetExceededMessage({max_dollars: '0.0000005'}, spent))
      .toBe("Flow budget exceeded before the next step: dollars $0.000001 used of $0.0000005 declared in the flow's budget header.");
    // Redundant trailing zeros are still the same limit, and equal is not over.
    expect(budgetExceededMessage({max_dollars: '0.0000010000'}, spent)).toBe('Flow budget exceeded before the next step.');
    expect(budgetExceededMessage({max_dollars: '0.0000009999'}, spent))
      .toBe("Flow budget exceeded before the next step: dollars $0.000001 used of $0.0000009999 declared in the flow's budget header.");
  });
  it('keeps the generic wording when the carried totals do not explain the kernel refusal', () => {
    // Equal is not over: the kernel compares strictly, so this total alone
    // did not trip it and the accumulator must not invent a reason.
    expect(budgetExceededMessage({max_wallclock_ms: 60_000, max_dollars: '1'}, {input: 0n, output: 0n, micro: 1_000_000n, ms: 60_000n, unmetered: false}))
      .toBe('Flow budget exceeded before the next step.');
  });
});

