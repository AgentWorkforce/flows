import ts from 'typescript';
import {
  assignedSources,
  type BindingPathSegment,
} from './shipped-source-binding-provenance.js';
import {
  aggregateMemberValue,
  aggregateValueAtPath,
  objectMemberValue,
  staticArrayElements,
  staticMemberSegment,
} from './shipped-source-binding-values.js';
import { assignedMemberValues } from './shipped-source-member-writes.js';

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

function memberReceiver(expression: ts.Expression): ts.Expression | undefined {
  expression = unwrap(expression);
  return ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
    ? expression.expression
    : undefined;
}

function canonicalArrayIndex(segment: BindingPathSegment): number | undefined {
  if (typeof segment === 'number') return Number.isInteger(segment) && segment >= 0 ? segment : undefined;
  return /^(?:0|[1-9]\d*)$/u.test(segment) ? Number(segment) : undefined;
}

export function aggregateExpressionValues(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): Array<{ value: ts.Expression; auditable: boolean; symbol?: ts.Symbol }> {
  const segment = staticMemberSegment(expression, checker, new Set(seen));
  const receiver = memberReceiver(expression);
  if (segment === undefined || !receiver) return [];
  const values: Array<{ value: ts.Expression; auditable: boolean; symbol?: ts.Symbol }> = [];
  const add = (value: (typeof values[number] & { alternatives?: ts.Expression[] }) | undefined): void => {
    if (!value) return;
    if (!values.some(candidate => candidate.value === value.value)) values.push(value);
    for (const alternative of value.alternatives ?? []) {
      if (!values.some(candidate => candidate.value === alternative)) {
        values.push({ value: alternative, auditable: false });
      }
    }
  };
  for (const value of assignedMemberValues(expression, checker, new Set(seen))) add(value);
  const unwrappedReceiver = unwrap(receiver);
  let receiverSymbol: ts.Symbol | undefined;
  if (ts.isIdentifier(unwrappedReceiver)) {
    const symbol = checker.getSymbolAtLocation(unwrappedReceiver);
    receiverSymbol = symbol;
    if (symbol && !seen.has(symbol)) {
      const sourceSeen = new Set(seen).add(symbol);
      for (const source of assignedSources(symbol, checker)) {
        const candidate = source.path.length === 0
          ? { value: source.initializer, auditable: false }
          : aggregateValueAtPath(source.initializer, source.path, checker, new Set(sourceSeen));
        if (!candidate) continue;
        if (source.rest?.kind === 'array') {
          const index = canonicalArrayIndex(segment);
          const elements = staticArrayElements(candidate.value, checker, new Set(sourceSeen))?.values;
          const value = index === undefined ? undefined : elements?.[source.rest.start + index];
          if (value) add({ value, auditable: false });
          continue;
        }
        if (source.rest?.kind === 'object') {
          const name = String(segment);
          if (!source.rest.excluded.includes(name)) {
            const value = objectMemberValue(candidate.value, name, checker, new Set(sourceSeen));
            if (value) add({ ...value, auditable: false });
          }
          continue;
        }
        const value = aggregateMemberValue(candidate.value, segment, checker, new Set(sourceSeen));
        if (value) add({ ...value, auditable: false });
      }
    }
  } else {
    for (const parent of aggregateExpressionValues(receiver, checker, seen)) {
      const value = aggregateMemberValue(parent.value, segment, checker, new Set(seen));
      if (value) add({ ...value, auditable: false });
    }
  }
  add(aggregateMemberValue(receiver, segment, checker, new Set(seen)));
  if (receiverSymbol) seen.add(receiverSymbol);
  return values;
}
