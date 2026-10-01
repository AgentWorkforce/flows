import ts from 'typescript';
import {
  assignedSourceMayPrecedeReference,
  assignedSources,
  type BindingPathSegment,
} from './shipped-source-binding-provenance.js';
import {
  aggregateMemberValue,
  aggregateValuesAtPath,
  objectMemberValue,
  staticArrayElements,
  staticMemberSegment,
} from './shipped-source-binding-values.js';

export interface AggregateReceiverValue {
  value: ts.Expression;
  auditable: boolean;
  symbol?: ts.Symbol;
  alternatives?: ts.Expression[];
}

export type MemberValueResolver = (
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
) => AggregateReceiverValue[];

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
  if (typeof segment === 'number') return Number.isInteger(segment) && segment >= 0 && segment <= 4_294_967_294 ? segment : undefined;
  return /^(?:0|[1-9]\d*)$/u.test(segment)
    && (segment.length < 10 || (segment.length === 10 && segment <= '4294967294'))
    ? Number(segment)
    : undefined;
}

export function resolveAggregateReceiverValues(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
  memberValues: MemberValueResolver,
): AggregateReceiverValue[] {
  const segment = staticMemberSegment(expression, checker, new Set(seen));
  const receiver = memberReceiver(expression);
  if (segment === undefined || !receiver) return [];
  const values: AggregateReceiverValue[] = [];
  const add = (value: AggregateReceiverValue | undefined): void => {
    if (!value) return;
    if (!values.some(candidate => candidate.value === value.value)) values.push(value);
    for (const alternative of value.alternatives ?? []) {
      if (!values.some(candidate => candidate.value === alternative)) {
        values.push({ value: alternative, auditable: false });
      }
    }
  };
  for (const value of memberValues(expression, checker, new Set(seen))) add(value);
  const unwrappedReceiver = unwrap(receiver);
  let receiverSymbol: ts.Symbol | undefined;
  if (ts.isIdentifier(unwrappedReceiver)) {
    const symbol = checker.getSymbolAtLocation(unwrappedReceiver);
    receiverSymbol = symbol;
    if (symbol && !seen.has(symbol)) {
      const sourceSeen = new Set(seen).add(symbol);
      for (const source of assignedSources(symbol, checker)) {
        if (!assignedSourceMayPrecedeReference(source, symbol, expression)) continue;
        const candidates = source.path.length === 0
          ? [source.initializer]
          : aggregateValuesAtPath(source.initializer, source.path, checker, new Set(sourceSeen));
        for (const candidate of candidates) {
          if (source.rest?.kind === 'array') {
            const index = canonicalArrayIndex(segment);
            const array = staticArrayElements(candidate, checker, new Set(sourceSeen));
            for (const elements of array ? [array.values, ...(array.alternatives ?? [])] : []) {
              const value = index === undefined ? undefined : elements[source.rest.start + index];
              if (value) add({ value, auditable: false });
            }
            continue;
          }
          if (source.rest?.kind === 'object') {
            const name = String(segment);
            if (!source.rest.excluded.includes(name)) {
              const value = objectMemberValue(candidate, name, checker, new Set(sourceSeen));
              if (value) add({ ...value, auditable: false });
            }
            continue;
          }
          const value = aggregateMemberValue(candidate, segment, checker, new Set(sourceSeen));
          if (value) add({ ...value, auditable: false });
        }
      }
    }
  } else {
    for (const parent of resolveAggregateReceiverValues(receiver, checker, seen, memberValues)) {
      const value = aggregateMemberValue(parent.value, segment, checker, new Set(seen));
      if (value) add({ ...value, auditable: false });
    }
  }
  add(aggregateMemberValue(receiver, segment, checker, new Set(seen)));
  if (receiverSymbol) seen.add(receiverSymbol);
  return values;
}
