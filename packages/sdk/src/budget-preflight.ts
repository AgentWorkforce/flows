import type { CompiledFlowSpec } from './compile.js';
import type { PreflightWarning } from './preflight.js';
import { hasPricing } from './model-pricing.js';
import { resolveAdapterKind } from './adapters/index.js';

/**
 * The resolved CLI/model pair budget pricing needs, deliberately narrower than
 * `ResolvedCliModel`: pricing depends only on *which* model will run (priced or
 * not) and on the CLI for the Codex wording — not on whether the model came
 * from authoring or an adapter default, which `ResolvedCliModel.source` records
 * for `flows check` reporting. Keeping `source` out means a future resolution
 * rung cannot change pricing by provenance alone.
 */
export interface BudgetStepResolution {
  readonly cli?: string;
  readonly model?: string;
}

/**
 * A missing price never refuses a run. Under a frozen dollar budget:
 * - a priced step journals exact dollars and a crossed `maxDollars` stops the
 *   run in the kernel;
 * - an unmetered step (no model, or no frozen price) runs and journals its
 *   tokens with `dollars_unmetered: true` (see `workerSpend`), so its unknown
 *   cost cannot cross `maxDollars` while its tokens still count toward token
 *   ceilings.
 * This warning names each unmetered step so the gap is reported, not silent.
 * Preflight `ok` stays true: warnings never refuse.
 *
 * Codex selects its own model when none is declared, so a Codex step is
 * expected to be unmetered and says so rather than asking for a fake price.
 */
export function budgetDiagnostics(
  flow: CompiledFlowSpec,
  resolved: ReadonlyMap<string, BudgetStepResolution> = new Map(),
): PreflightWarning[] {
  if (flow.budget?.pricing !== 'frozen' || flow.budget.maxDollars === undefined) return [];
  const warnings: PreflightWarning[] = [];
  for (const step of flow.steps) {
    if (step.type === 'deterministic') continue;
    const resolution = resolved.get(step.id);
    const model = resolution?.model
      ?? step.model ?? (step.type === 'agent' && step.agent !== undefined
        ? flow.agents?.[step.agent]?.model : undefined);
    if (hasPricing(model)) continue;
    const cli = resolution?.cli ?? step.cli;
    const reason = model !== undefined
      ? `model "${model}" has no frozen price`
      : cli !== undefined && resolveAdapterKind(cli) === 'codex'
        ? 'Codex selects its own model'
        : 'no model is declared';
    warnings.push({
      severity: 'warning', kind: 'budget_unmetered', stepId: step.id,
      message: `Step "${step.id}" is unmetered (${reason}); it does not count toward the dollar budget.`,
    });
  }
  return warnings;
}
