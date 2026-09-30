import ts from 'typescript';
import { resolveAggregateReceiverValues } from './shipped-source-aggregate-receiver-values.js';
import { directAssignedMemberValues } from './shipped-source-direct-member-writes.js';

export function baseAggregateExpressionValues(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): Array<{
  value: ts.Expression;
  auditable: boolean;
  symbol?: ts.Symbol;
  alternatives?: ts.Expression[];
}> {
  return resolveAggregateReceiverValues(expression, checker, seen, directAssignedMemberValues);
}
