import type { BudgetSpec, KernelBudgetSpec } from './spec.js';

export type HeaderBudget = string | { tokens?: number; dollars?: number; wallclock?: string };

export class BudgetSyntaxError extends Error {
  constructor() { super('budget_syntax_invalid: expected $<amount>/run, $<amount>/day, or { tokens, dollars, wallclock }'); }
}

/** Normalize surface sugar; existing explicit envelopes remain supported. */
export function parseBudget(value: unknown): BudgetSpec {
  if (typeof value === 'string') {
    const match = /^\$(\d+(?:\.\d{1,6})?)\/(run|day)$/.exec(value);
    if (!match) throw new BudgetSyntaxError();
    return { pricing: 'frozen', maxDollars: match[1]!, ...(match[2] === 'day' ? { window: 'day' as const } : {}) };
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new BudgetSyntaxError();
  const b = value as Record<string, unknown>;
  const legacy = ['maxTokensIn', 'maxTokensOut', 'maxTokens', 'maxDollars', 'maxWallclockMs', 'window', 'pricing'];
  if (Object.keys(b).some(k => legacy.includes(k))) {
    if (Object.keys(b).some(k => !legacy.includes(k))) throw new BudgetSyntaxError();
    return b as BudgetSpec;
  }
  if (Object.keys(b).some(k => !['tokens', 'dollars', 'wallclock'].includes(k))) throw new BudgetSyntaxError();
  if (b.tokens !== undefined && (!Number.isSafeInteger(b.tokens) || (b.tokens as number) < 0)) throw new BudgetSyntaxError();
  if (b.dollars !== undefined && (typeof b.dollars !== 'number' || !Number.isFinite(b.dollars) || b.dollars < 0 || !/^\d+(?:\.\d{1,6})?$/.test(String(b.dollars)))) throw new BudgetSyntaxError();
  let ms: number | undefined;
  if (b.wallclock !== undefined) {
    const match = typeof b.wallclock === 'string' && /^(\d+)(ms|s|m|h|d)$/.exec(b.wallclock);
    if (!match) throw new BudgetSyntaxError();
    ms = Number(match[1]) * ({ms:1,s:1000,m:60000,h:3600000,d:86400000}[match[2]!]!);
    if (!Number.isSafeInteger(ms)) throw new BudgetSyntaxError();
  }
  return { pricing: 'frozen', ...(b.tokens === undefined ? {} : {maxTokens: b.tokens as number}),
    ...(b.dollars === undefined ? {} : {maxDollars: String(b.dollars)}),
    ...(ms === undefined ? {} : {maxWallclockMs: ms}) };
}

/** Lower a normalized envelope to the existing kernel protocol. */
export function toKernelBudget(budget: BudgetSpec): KernelBudgetSpec {
  return {
    ...(budget.pricing !== undefined ? { pricing: budget.pricing } : {}),
    ...(budget.maxTokens !== undefined ? { max_tokens: budget.maxTokens } : {}),
    ...(budget.maxWallclockMs !== undefined ? { max_wallclock_ms: budget.maxWallclockMs } : {}),
    ...(budget.window !== undefined ? { window: budget.window } : {}),
    ...(budget.maxTokensIn !== undefined ? { max_tokens_in: budget.maxTokensIn } : {}),
    ...(budget.maxTokensOut !== undefined ? { max_tokens_out: budget.maxTokensOut } : {}),
    ...(budget.maxDollars !== undefined ? { max_dollars: budget.maxDollars } : {}),
  };
}
