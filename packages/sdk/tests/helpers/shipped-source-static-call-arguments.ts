import ts from 'typescript';
import { staticArrayElements } from './shipped-source-binding-values.js';

export function staticArrayElementCandidates(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): Array<{ values: Array<ts.Expression | undefined>; auditable: boolean }> {
  const value = staticArrayElements(expression, checker, seen);
  return value ? [
    value,
    ...(value.alternatives ?? []).map(values => ({ values, auditable: false })),
  ] : [];
}

export function staticCallArgumentCandidates(
  args: readonly ts.Expression[],
  checker: ts.TypeChecker,
): Array<{ values: ts.Expression[]; auditable: boolean }> {
  let candidates: Array<{ values: ts.Expression[]; auditable: boolean }> = [{ values: [], auditable: true }];
  for (const argument of args) {
    if (!ts.isSpreadElement(argument)) {
      for (const candidate of candidates) candidate.values.push(argument);
      continue;
    }
    const spreads = staticArrayElementCandidates(argument.expression, checker, new Set())
      .filter((candidate): candidate is { values: ts.Expression[]; auditable: boolean } =>
        candidate.values.every((value): value is ts.Expression =>
          value !== undefined && !ts.isSpreadElement(value)));
    if (spreads.length === 0 || candidates.length * spreads.length > 64) return [];
    candidates = candidates.flatMap(prefix => spreads.map(spread => ({
      values: [...prefix.values, ...spread.values],
      auditable: false,
    })));
  }
  return candidates;
}
