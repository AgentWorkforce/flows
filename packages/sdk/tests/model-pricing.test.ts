import { describe, expect, it } from 'vitest';
import { pricedUsage, hasPricing, MODEL_PRICING } from '../src/model-pricing.js';
import { workerSpend } from '../src/worker-spend.js';

describe('pricedUsage', () => {
  it('prices a listed model to microdollar-exact dollars', () => {
    const usage = pricedUsage('claude-sonnet-4-6', 1_000_000, 500_000);
    expect(usage).toEqual({ tokens_in: 1_000_000, tokens_out: 500_000, dollars: '10.500000' });
  });

  it('uses the frozen Claude Opus 5 standard rate', () => {
    expect(pricedUsage('claude-opus-5', 1_000_000, 500_000)).toEqual({
      tokens_in: 1_000_000, tokens_out: 500_000, dollars: '17.500000',
    });
  });

  it('returns undefined for an unpriced model rather than throwing after decode', () => {
    // Regression for the Cursor Bugbot HIGH finding "Unlisted models fail
    // after usage decode": the runtime previously threw here after the CLI
    // had already spent tokens. Preflight warns `budget_unmetered` instead, and
    // `workerSpend` turns this undefined into unmetered usage, so an
    // unpriced-model step wastes nothing on the pricing check itself.
    expect(pricedUsage('unlisted-model', 100, 50)).toBeUndefined();
    expect(pricedUsage('unlisted-model', 0, 0)).toBeUndefined();
  });

  it('returns undefined when no model is declared', () => {
    expect(pricedUsage(undefined, 100, 50)).toBeUndefined();
  });

  it('rejects invalid token counts', () => {
    expect(() => pricedUsage('claude-sonnet-4-6', -1, 0)).toThrow(/Invalid token usage/);
    expect(() => pricedUsage('claude-sonnet-4-6', 0, 1.5)).toThrow(/Invalid token usage/);
  });

  it('hasPricing agrees with MODEL_PRICING membership', () => {
    for (const key of Object.keys(MODEL_PRICING)) expect(hasPricing(key)).toBe(true);
    expect(hasPricing('unlisted-model')).toBe(false);
    expect(hasPricing(undefined)).toBe(false);
  });
});

describe('workerSpend', () => {
  const priced = { exit_code: 0, stdout_tail: '', stderr_tail: '', tokens_input: 100, tokens_output: 50 };

  it('attaches usage for priced models', () => {
    const spent = workerSpend(priced, 'claude-sonnet-4-6');
    expect(spent.usage).toEqual({ tokens_in: 100, tokens_out: 50, dollars: '0.001050' });
    expect(spent.result.exit_code).toBe(0);
  });

  it('keeps an unpriced model step metered for tokens but not dollars, without failing it', () => {
    // The step still succeeded — an unpriced model is a preflight warning
    // when a dollar budget is declared, not a runtime failure. Its tokens must
    // still reach the kernel so token budgets see the step.
    // Its dollars are unknown, so usage says so instead of claiming $0.
    for (const model of ['unlisted-model', undefined]) {
      const spent = workerSpend(priced, model);
      expect(spent.usage).toEqual({ tokens_in: 100, tokens_out: 50, dollars_unmetered: true });
      expect(spent.usage).not.toHaveProperty('dollars');
      expect(spent.result.exit_code).toBe(0);
      expect(spent.result.stderr_tail).toBe('');
    }
  });

  it('still marks an unpriced step unmetered when its CLI reported no tokens', () => {
    const unreported = { exit_code: 0, stdout_tail: '', stderr_tail: '' };
    expect(workerSpend(unreported, 'unlisted-model').usage).toEqual({ tokens_in: 0, tokens_out: 0, dollars_unmetered: true });
    expect(workerSpend(unreported).usage).toEqual({ tokens_in: 0, tokens_out: 0, dollars_unmetered: true });
  });

  it('journals invalid token counts as worker_error, projecting clamped counts', () => {
    const bad = { ...priced, tokens_input: -1 };
    const spent = workerSpend(bad, 'claude-sonnet-4-6');
    expect(spent.result.exit_code).toBeNull();
    expect(spent.result.stderr_tail).toMatch(/Invalid token usage/);
    expect(spent.usage).toBeUndefined();
  });
});
