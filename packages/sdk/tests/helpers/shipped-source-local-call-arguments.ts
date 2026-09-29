import ts from 'typescript';
import type { BindingPathSegment } from './shipped-source-binding-provenance.js';
import {
  staticArrayElements,
  staticPropertySegment,
} from './shipped-source-binding-values.js';

export interface BindingNamePath {
  path: BindingPathSegment[];
  rest?: { excluded: string[]; kind: 'object' } | { kind: 'array'; start: number };
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

function propertyName(
  name: ts.PropertyName | undefined,
  checker: ts.TypeChecker,
): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (!ts.isComputedPropertyName(name)) return undefined;
  if (ts.isStringLiteralLike(name.expression)) return name.expression.text;
  const segment = staticPropertySegment(name.expression, checker, new Set());
  return segment === undefined ? undefined : String(segment);
}

export function bindingNamePaths(
  name: ts.BindingName,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  path: BindingPathSegment[] = [],
  rest?: BindingNamePath['rest'],
): BindingNamePath[] {
  if (ts.isIdentifier(name)) {
    return checker.getSymbolAtLocation(name) === symbol ? [{ path, ...(rest ? { rest } : {}) }] : [];
  }
  if (ts.isArrayBindingPattern(name)) return name.elements.flatMap((element, index) => {
    if (ts.isOmittedExpression(element)) return [];
    return bindingNamePaths(
      element.name,
      symbol,
      checker,
      element.dotDotDotToken ? path : [...path, index],
      element.dotDotDotToken ? { kind: 'array', start: index } : rest,
    );
  });
  const excluded: string[] = [];
  return name.elements.flatMap(element => {
    const segment = propertyName(
      element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined),
      checker,
    );
    if (element.dotDotDotToken) {
      return bindingNamePaths(element.name, symbol, checker, path, {
        excluded: [...excluded],
        kind: 'object',
      });
    }
    if (segment !== undefined) excluded.push(segment);
    return segment === undefined
      ? []
      : bindingNamePaths(element.name, symbol, checker, [...path, segment], rest);
  });
}

export function canonicalArrayIndex(segment: BindingPathSegment): number | undefined {
  if (typeof segment === 'number') return Number.isInteger(segment) && segment >= 0 ? segment : undefined;
  return /^(?:0|[1-9]\d*)$/u.test(segment) ? Number(segment) : undefined;
}

export function isStaticallyUndefined(expression: ts.Expression, checker: ts.TypeChecker): boolean {
  expression = unwrap(expression);
  return ts.isVoidExpression(expression)
    || (ts.isIdentifier(expression) && expression.text === 'undefined')
    || (checker.getTypeAtLocation(expression).flags & ts.TypeFlags.Undefined) !== 0;
}

export function localCallArgumentCandidates(
  args: readonly ts.Expression[],
  checker: ts.TypeChecker,
): ts.Expression[][] {
  let candidates: ts.Expression[][] = [[]];
  for (const argument of args) {
    if (!ts.isSpreadElement(argument)) {
      candidates.forEach(values => values.push(argument));
      continue;
    }
    const spread = staticArrayElements(argument.expression, checker, new Set());
    if (!spread) return [[...args]];
    const branches = [spread.values, ...(spread.alternatives ?? [])]
      .filter(values => values.every((value): value is ts.Expression => value !== undefined));
    if (branches.length === 0 || candidates.length * branches.length > 64) return [[...args]];
    candidates = candidates.flatMap(prefix => branches.map(values => [...prefix, ...values]));
  }
  return candidates;
}
