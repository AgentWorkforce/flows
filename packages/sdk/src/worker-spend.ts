import { pricedUsage } from './model-pricing.js';
import type { WorkerCliResult } from './worker-cli.js';

/** Pricing failures are journaled worker errors, never dropped completions. */
export function workerSpend(result: WorkerCliResult, model?: string) {
  try { return { result, usage: pricedUsage(model, result.tokens_input, result.tokens_output) }; }
  catch (error) {
    return {
      result: { ...result, exit_code: null, stderr_tail: error instanceof Error ? error.message : 'Invalid model usage' },
      usage: pricedUsage(undefined,
        Number.isSafeInteger(result.tokens_input) && result.tokens_input! >= 0 ? result.tokens_input : 0,
        Number.isSafeInteger(result.tokens_output) && result.tokens_output! >= 0 ? result.tokens_output : 0),
    };
  }
}
