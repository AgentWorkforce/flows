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

export function staticCallArguments(
  args: readonly ts.Expression[],
  checker: ts.TypeChecker,
): { values: ts.Expression[]; auditable: boolean } | undefined {
  const values: ts.Expression[] = [];
  let auditable = true;
  for (const argument of args) {
    if (!ts.isSpreadElement(argument)) {
      values.push(argument);
      continue;
    }
    const spread = staticArrayElements(argument.expression, checker, new Set());
    if (!spread || spread.values.some(value => value === undefined)) return undefined;
    values.push(...spread.values as ts.Expression[]);
    auditable = false;
  }
  return { values, auditable };
}
