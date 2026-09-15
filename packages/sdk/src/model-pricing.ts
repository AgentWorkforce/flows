/** Frozen dollars per million tokens. Each rate is an integer microdollar per token. */
export const MODEL_PRICING: Readonly<Record<string, Readonly<{ input: number; output: number }>>> = Object.freeze({
  'claude-sonnet-4-6': Object.freeze({ input: 3, output: 15 }),
  'claude-opus-4-7': Object.freeze({ input: 15, output: 75 }),
  'claude-opus-5': Object.freeze({ input: 5, output: 25 }),
  'codex-medium': Object.freeze({ input: 2, output: 8 }),
  'codex-large': Object.freeze({ input: 5, output: 20 }),
});

export function hasPricing(model: string | undefined): boolean {
  return model !== undefined && Object.hasOwn(MODEL_PRICING, model);
}

/**
 * Cost accounting for a step's declared model.
 *
 * Returns `undefined` for unpriced models, meaning "no known dollar cost" —
 * never a zero price. Workers do not omit usage on that signal: `workerSpend`
 * falls back to unmetered usage (reported tokens plus `dollars_unmetered: true`,
 * no `dollars`), so token ceilings still count the step and the journal records
 * its dollars as unknown. An unpriced step is unmetered, not refused:
 * `budgetDiagnostics` warns about it at preflight and it cannot cross
 * `maxDollars`. Codex model ids need no entry here; Codex selects its own model.
 */
export function pricedUsage(model: string | undefined, input = 0, output = 0):
  | { tokens_in: number; tokens_out: number; dollars: string }
  | undefined
{
  if (![input, output].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid token usage');
  const price = model === undefined || !Object.hasOwn(MODEL_PRICING, model) ? undefined : MODEL_PRICING[model];
  if (price === undefined) return undefined;
  const micro = BigInt(input) * BigInt(price.input) + BigInt(output) * BigInt(price.output);
  return { tokens_in: input, tokens_out: output, dollars: `${micro / 1_000_000n}.${String(micro % 1_000_000n).padStart(6, '0')}` };
}
