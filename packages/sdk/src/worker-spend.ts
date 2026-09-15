import { pricedUsage } from './model-pricing.js';
import type { StepUsage } from './protocol.js';
import type { WorkerCliResult } from './worker-cli.js';

/**
 * Usage for a step whose dollar cost is unknown (unpriced or undeclared model).
 *
 * It carries the reported tokens and `dollars_unmetered: true`, and never a
 * `dollars` amount: unknown cost is not journaled as a measured $0. The kernel
 * records the flag on the step's `budget`/`spend` and on the run total, counts
 * the tokens toward token ceilings, and compares only metered dollars against
 * `maxDollars`. A CLI that reported no tokens still marks the step unmetered,
 * with zero tokens — the same token accounting any unreported step gets.
 */
function unmeteredUsage(input: number | undefined, output: number | undefined): StepUsage {
  return { tokens_in: input ?? 0, tokens_out: output ?? 0, dollars_unmetered: true };
}

/**
 * Attach token/dollar usage to a worker's CLI result. Invalid token counts
 * (non-integer or negative) are the one remaining failure mode — those are
 * journaled as `worker_error` with the usage projected from clamped counts.
 *
 * Contract across preflight → worker → kernel (keep all three aligned):
 * - preflight (`budgetDiagnostics`) warns `budget_unmetered` for a
 *   dollar-budgeted step with no frozen price and lets it run;
 * - this function returns priced usage (`dollars`) for a priced model, and
 *   unmetered usage (`dollars_unmetered: true`, no `dollars`) otherwise —
 *   never `undefined` for a successful decode, so token ceilings always see the
 *   step and the journal always says whether its dollars are known;
 * - the kernel (`machine/budget.rs`) enforces tokens on every charge and
 *   dollars on metered charges only, and rejects unmetered usage that also
 *   claims non-zero dollars.
 * `tests/budget-unmetered-live.test.ts` pins the chain end to end.
 */
export function workerSpend(result: WorkerCliResult, model?: string): { result: WorkerCliResult; usage: StepUsage | undefined } {
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
