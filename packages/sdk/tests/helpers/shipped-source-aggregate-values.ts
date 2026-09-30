import ts from 'typescript';
import { resolveAggregateReceiverValues } from './shipped-source-aggregate-receiver-values.js';
import { assignedMemberValues } from './shipped-source-member-writes.js';

export function aggregateExpressionValues(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): Array<{ value: ts.Expression; auditable: boolean; symbol?: ts.Symbol }> {
  return resolveAggregateReceiverValues(expression, checker, seen, assignedMemberValues);
}
