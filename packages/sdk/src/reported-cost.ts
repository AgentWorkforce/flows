import { MODEL_PRICING } from './model-pricing.js';
import type { ReportedCost } from './protocol.js';
import type { WorkerCliResult } from './worker-cli.js';

/**
 * What a step attempt actually cost, for display. Never enforcement.
 *
 * The metered `usage` (`workerSpend`) is what the kernel charges against
 * `maxDollars`, and it prices only plain input and output tokens. That
 * undercounts cache-heavy agents badly. This is the real figure a reader wants
 * to see, and it rides beside the metered charge as `reported_cost`: the kernel
 * journals it and never folds it into the budget. Changing which charges count
 * toward a cap is a separate decision, and this module takes no part in it.
 *
 * Sources, in order:
 * - `cli`: the CLI's own reported total (Claude `total_cost_usd`);
 * - `priced`: an estimate from the digest's full token usage at the frozen
 *   `MODEL_PRICING` rates, with cache writes at 1.25x and cache reads at 0.1x
 *   the input rate. Only for a model that already has a price.
 * Otherwise undefined: an unknown cost is left unknown, never shown as $0.
 */
export function reportedCost(result: WorkerCliResult, model: string | undefined): ReportedCost | undefined {
  const digest = result.transcript?.result;
  const cli = digest?.total_cost_usd;
  if (typeof cli === 'number' && Number.isFinite(cli) && cli >= 0) {
    return { dollars: microDollars(BigInt(Math.round(cli * 1_000_000))), source: 'cli' };
  }
  const usage = digest?.usage;
  const priceModel = digest?.model ?? model;
  if (usage === undefined || priceModel === undefined || !Object.hasOwn(MODEL_PRICING, priceModel)) return undefined;
  const counts = [usage.input, usage.output, usage.cache_read, usage.cache_creation].map(n => n ?? 0);
  if (!counts.every(n => Number.isSafeInteger(n) && n >= 0)) return undefined;
  const [input, output, cacheRead, cacheCreation] = counts.map(BigInt) as [bigint, bigint, bigint, bigint];
  const price = MODEL_PRICING[priceModel]!;
  const inRate = BigInt(price.input);
  const micro = input * inRate + output * BigInt(price.output)
    + (cacheCreation * inRate * 125n) / 100n + (cacheRead * inRate * 10n) / 100n;
  return { dollars: microDollars(micro), source: 'priced' };
}

function microDollars(micro: bigint): string {
  return `${micro / 1_000_000n}.${String(micro % 1_000_000n).padStart(6, '0')}`;
}
