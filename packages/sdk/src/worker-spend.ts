import { pricedUsage } from './model-pricing.js';
import type { WorkerCliResult } from './worker-cli.js';

/**
 * Attach token/dollar usage to a worker's CLI result. Invalid token counts
 * (non-integer or negative) are the one remaining failure mode — those are
 * journaled as `worker_error` with the usage projected from clamped counts.
 *
 * Unpriced models are NOT a failure here: `pricedUsage` returns undefined, so
 * the step journals no dollars and never trips a dollar budget. Preflight
 * (see `budgetDiagnostics`) warns that such a step is unmetered.
 */
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
