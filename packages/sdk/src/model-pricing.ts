/** Frozen dollars per million tokens. Each rate is an integer microdollar per token. */
export const MODEL_PRICING: Readonly<Record<string, Readonly<{ input: number; output: number }>>> = Object.freeze({
  'claude-sonnet-4-6': Object.freeze({ input: 3, output: 15 }),
  'claude-opus-4-7': Object.freeze({ input: 15, output: 75 }),
  'codex-medium': Object.freeze({ input: 2, output: 8 }),
  'codex-large': Object.freeze({ input: 5, output: 20 }),
});

export function pricedUsage(model: string | undefined, input = 0, output = 0) {
  if (![input, output].every(n => Number.isSafeInteger(n) && n >= 0)) throw new Error('Invalid token usage');
  const price = model === undefined || !Object.hasOwn(MODEL_PRICING, model) ? undefined : MODEL_PRICING[model];
  if (model !== undefined && price === undefined && input + output > 0) throw new Error(`budget_missing_price: ${model}`);
  const micro = BigInt(input) * BigInt(price?.input ?? 0) + BigInt(output) * BigInt(price?.output ?? 0);
  return { tokens_in: input, tokens_out: output, dollars: `${micro / 1_000_000n}.${String(micro % 1_000_000n).padStart(6, '0')}` };
}
