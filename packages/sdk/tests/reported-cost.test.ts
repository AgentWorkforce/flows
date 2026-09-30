import { describe, expect, it } from 'vitest';
import { reportedCost } from '../src/reported-cost.js';
import { workerSpend } from '../src/worker-spend.js';
import type { WorkerCliResult } from '../src/worker-cli.js';

const base = { exit_code: 0, stdout_tail: '', stderr_tail: '' } as const;
const withDigest = (result: NonNullable<WorkerCliResult['transcript']>['result'], tokens?: { in: number; out: number }): WorkerCliResult => ({
  ...base, ...(tokens === undefined ? {} : { tokens_input: tokens.in, tokens_output: tokens.out }),
  transcript: { result },
});

describe('reportedCost', () => {
  it('prefers the CLI\'s own total, at six decimal places', () => {
    expect(reportedCost(withDigest({ provider: 'claude', total_cost_usd: 7.1694050000000025 }), 'claude-opus-5'))
      .toEqual({ dollars: '7.169405', source: 'cli' });
  });

  it('estimates a priced model from full usage, including cache tokens the metered charge leaves out', () => {
    const result = withDigest({ provider: 'claude', model: 'claude-opus-5',
      usage: { input: 166, output: 38_861, cache_read: 2_000_000, cache_creation: 100_000 } }, { in: 166, out: 38_861 });
    // 166*$5/M + 38861*$25/M + 100000*$5/M*1.25 + 2000000*$5/M*0.1
    expect(reportedCost(result, 'claude-opus-5')).toEqual({ dollars: '2.597355', source: 'priced' });
    // Enforcement is untouched: the metered charge still prices input and output only.
    expect(workerSpend(result, 'claude-opus-5').usage).toEqual({ tokens_in: 166, tokens_out: 38_861, dollars: '0.972355' });
  });

  it('charges a Codex step\'s cached input once: its input total already includes it', () => {
    const result = withDigest({ provider: 'codex', model: 'codex-medium', usage: { input: 1_000_000, output: 0, cache_read: 800_000 } });
    // 200000 fresh * $2/M + 800000 cached * $2/M * 0.1
    expect(reportedCost(result, 'codex-medium')).toEqual({ dollars: '0.560000', source: 'priced' });
  });

  it('leaves an unknown cost unknown rather than reporting $0', () => {
    expect(reportedCost({ ...base }, 'claude-opus-5')).toBeUndefined();
    expect(reportedCost(withDigest({ provider: 'codex', usage: { input: 10, output: 10 } }), 'gpt-unpriced')).toBeUndefined();
    expect(reportedCost(withDigest({ provider: 'claude', total_cost_usd: Number.NaN }), undefined)).toBeUndefined();
  });
});
