import { pricedUsage } from './model-pricing.js';
import type { WorkerCliResult } from './worker-cli.js';

/** Zero-dollar usage for an unpriced step, only when the CLI reported tokens. */
function unmeteredUsage(input: number | undefined, output: number | undefined) {
  if (input === undefined || output === undefined) return undefined;
  return { tokens_in: input, tokens_out: output, dollars: '0.000000' };
}

/**
 * Attach token/dollar usage to a worker's CLI result. Invalid token counts
 * (non-integer or negative) are the one remaining failure mode — those are
 * journaled as `worker_error` with the usage projected from clamped counts.
 *
 * Unpriced models are NOT a failure here: the step journals zero dollars, so it
 * never trips a dollar budget, but its reported tokens still count toward any
 * token budget. Preflight (see `budgetDiagnostics`) warns that such a step is
 * unmetered for dollars.
 */
export function workerSpend(result: WorkerCliResult, model?: string) {
  try {
    const usage = pricedUsage(model, result.tokens_input, result.tokens_output)
      ?? unmeteredUsage(result.tokens_input, result.tokens_output);
    return { result, usage };
  }
  catch (error) {
    return {
      result: { ...result, exit_code: null, stderr_tail: error instanceof Error ? error.message : 'Invalid model usage' },
      usage: pricedUsage(undefined,
        Number.isSafeInteger(result.tokens_input) && result.tokens_input! >= 0 ? result.tokens_input : 0,
        Number.isSafeInteger(result.tokens_output) && result.tokens_output! >= 0 ? result.tokens_output : 0),
    };
  }
}
