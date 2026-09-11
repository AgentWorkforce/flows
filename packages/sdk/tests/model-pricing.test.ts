import { describe, expect, it } from 'vitest';
import { pricedUsage, hasPricing, MODEL_PRICING } from '../src/model-pricing.js';
import { workerSpend } from '../src/worker-spend.js';

describe('pricedUsage', () => {
  it('prices a listed model to microdollar-exact dollars', () => {
    const usage = pricedUsage('claude-sonnet-4-6', 1_000_000, 500_000);
    expect(usage).toEqual({ tokens_in: 1_000_000, tokens_out: 500_000, dollars: '10.500000' });
  });

  it('returns undefined for an unpriced model rather than throwing after decode', () => {
    // Regression for the Cursor Bugbot HIGH finding "Unlisted models fail
    // after usage decode": the runtime previously threw here after the CLI
    // had already spent tokens. Preflight now owns the refusal; the runtime
    // path is permissive so an unpriced-model step wastes nothing on the
    // pricing check itself.
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

  it('leaves usage undefined for an unpriced model without failing the step', () => {
    // The step still succeeded — an unpriced model is a preflight concern
    // when a dollar budget is declared, not a runtime failure per se.
    const spent = workerSpend(priced, 'unlisted-model');
    expect(spent.usage).toBeUndefined();
    expect(spent.result.exit_code).toBe(0);
    expect(spent.result.stderr_tail).toBe('');
  });

  it('journals invalid token counts as worker_error, projecting clamped counts', () => {
    const bad = { ...priced, tokens_input: -1 };
    const spent = workerSpend(bad, 'claude-sonnet-4-6');
    expect(spent.result.exit_code).toBeNull();
    expect(spent.result.stderr_tail).toMatch(/Invalid token usage/);
    expect(spent.usage).toBeUndefined();
  });
});
