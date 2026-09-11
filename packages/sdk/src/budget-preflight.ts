import type { CompiledFlowSpec } from './compile.js';
import type { PreflightRefusal } from './preflight.js';
import { MODEL_PRICING } from './model-pricing.js';

/** Legacy explicit envelopes keep their worker-supplied pricing contract. */
export function budgetDiagnostics(flow: CompiledFlowSpec): PreflightRefusal[] {
  if (flow.budget?.pricing !== 'frozen') return [];
  const diagnostics: PreflightRefusal[] = [];
  const declared = [
    ...Object.entries(flow.agents ?? {}).map(([agent, d]) => ({ agent, model: d.model })),
    ...flow.steps.flatMap(s => s.type !== 'deterministic' && s.model !== undefined
      ? [{ stepId: s.id, model: s.model }] : []),
  ];
  for (const step of flow.steps) {
    if (step.type === 'deterministic' || flow.budget.maxDollars === undefined) continue;
    const model = step.model ?? (step.type === 'agent' && step.agent !== undefined
      ? flow.agents?.[step.agent]?.model : undefined);
    if (model === undefined) diagnostics.push({
      severity: 'refusal', kind: 'budget_missing_price', stepId: step.id,
      message: `Step "${step.id}" needs a declared, priced model for its dollar budget.`,
    });
  }
  for (const declaration of declared) {
    if (Object.hasOwn(MODEL_PRICING, declaration.model)) continue;
    diagnostics.push({
      severity: 'refusal', kind: 'budget_missing_price', ...declaration,
      message: `Model "${declaration.model}" has no frozen price for budget accounting.`,
    });
  }
  return diagnostics;
}
