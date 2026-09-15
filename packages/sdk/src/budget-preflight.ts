import type { CompiledFlowSpec } from './compile.js';
import type { PreflightWarning } from './preflight.js';
import { hasPricing } from './model-pricing.js';
import { resolveAdapterKind } from './adapters/index.js';

export interface BudgetStepResolution {
  readonly cli?: string;
  readonly model?: string;
}

/**
 * Dollar budgets are light enforcement: pricing never refuses a run. A step
 * whose model has no frozen price journals no dollars (`pricedUsage` returns
 * undefined), so it cannot trip `maxDollars`; priced steps still accrue and a
 * crossed limit still stops the run in the kernel. This warning names each
 * unmetered step so the gap is reported, not silent.
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
