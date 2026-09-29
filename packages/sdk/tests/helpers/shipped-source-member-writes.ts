import ts from 'typescript';
import {
  assignedValues,
  bindingDefaultValues,
  bindingSource,
  type BindingPathSegment,
} from './shipped-source-binding-provenance.js';
import {
  aggregateExpressionValues,
  aggregateValueAtPath,
  staticPropertySegment,
  wrappedExpressionBranches,
} from './shipped-source-binding-values.js';
import { intrinsicInvocationArgumentCandidates } from './shipped-source-intrinsic-invocations.js';

export interface ReflectiveMemberAssignedSource {
  initializer: ts.Expression;
  path: BindingPathSegment[];
  sourcePath: BindingPathSegment[];
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

function memberAssignmentPath(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): { path: BindingPathSegment[]; symbol: ts.Symbol } | undefined {
  expression = unwrap(expression);
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    return symbol ? { path: [], symbol } : undefined;
  }
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return undefined;
  const parent = memberAssignmentPath(expression.expression, checker);
  if (!parent) return undefined;
  const segment = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : expression.argumentExpression
      ? staticPropertySegment(expression.argumentExpression, checker, new Set([parent.symbol]))
      : undefined;
  return segment === undefined ? undefined : { ...parent, path: [...parent.path, segment] };
}

function objectLiteralCandidates(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ts.ObjectLiteralExpression[] {
  expression = unwrap(expression);
  if (ts.isObjectLiteralExpression(expression)) return [expression];
  const branches = wrappedExpressionBranches(expression);
  if (branches) return branches.flatMap(branch =>
    objectLiteralCandidates(branch, checker, new Set(seen)));
  const values: ts.ObjectLiteralExpression[] = [];
  const add = (candidate: ts.Expression | undefined): void => {
    if (!candidate) return;
    for (const value of objectLiteralCandidates(candidate, checker, new Set(seen))) {
      if (!values.includes(value)) values.push(value);
    }
  };
  const aggregateSeen = new Set(seen);
  for (const aggregate of aggregateExpressionValues(expression, checker, aggregateSeen)) {
    add(aggregate.value);
  }
  if (!ts.isIdentifier(expression)) return values;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return values;
  seen.add(symbol);
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding) {
    const source = bindingSource(binding, checker, new Set(seen));
    if (source) {
      add(aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen))?.value);
      for (const fallback of bindingDefaultValues(source, checker, new Set(seen))) add(fallback.value);
    }
    add(binding.initializer);
  }
  for (const assigned of assignedValues(symbol, checker)) add(assigned);
  add(symbol.declarations?.find(ts.isVariableDeclaration)?.initializer);
  return values;
}

export function reflectiveMemberAssignedSources(
  node: ts.CallExpression,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): ReflectiveMemberAssignedSource[] {
  const values: ReflectiveMemberAssignedSource[] = [];
  const targetFor = (args: readonly ts.Expression[]) => {
    const target = args[0] ? memberAssignmentPath(args[0], checker) : undefined;
    return target?.symbol === symbol ? target : undefined;
  };
  for (const args of intrinsicInvocationArgumentCandidates(node, 'Object', 'assign', checker)) {
    const target = targetFor(args);
    if (!target) continue;
    values.push(...args.slice(1).map(initializer => ({
      initializer,
      path: target.path,
      sourcePath: [],
    })));
  }
  for (const args of intrinsicInvocationArgumentCandidates(node, 'Reflect', 'set', checker)) {
    const target = targetFor(args);
    const segment = args[1]
      ? staticPropertySegment(args[1], checker, new Set([symbol]))
      : undefined;
    const initializer = args[2];
    if (target && segment !== undefined && initializer) values.push({
      initializer,
      path: [...target.path, segment],
      sourcePath: [],
    });
  }
  for (const [intrinsic, name] of [
    ['Object', 'defineProperty'],
    ['Reflect', 'defineProperty'],
  ] as const) {
    for (const args of intrinsicInvocationArgumentCandidates(node, intrinsic, name, checker)) {
      const target = targetFor(args);
      const segment = args[1]
        ? staticPropertySegment(args[1], checker, new Set([symbol]))
        : undefined;
      const descriptor = args[2];
      if (target && segment !== undefined && descriptor) values.push({
        initializer: descriptor,
        path: [...target.path, segment],
        sourcePath: ['value'],
      });
    }
  }
  for (const args of intrinsicInvocationArgumentCandidates(node, 'Object', 'defineProperties', checker)) {
    const target = targetFor(args);
    const descriptors = args[1];
    if (!target || !descriptors) continue;
    for (const candidate of objectLiteralCandidates(descriptors, checker, new Set([symbol]))) {
      for (const property of candidate.properties) {
        if (!ts.isPropertyAssignment(property)) continue;
        const segment = propertyName(property.name, checker);
        if (segment !== undefined) values.push({
          initializer: property.initializer,
          path: [...target.path, segment],
          sourcePath: ['value'],
        });
      }
    }
  }
  for (const [intrinsic, name] of [
    ['Object', 'setPrototypeOf'],
    ['Reflect', 'setPrototypeOf'],
  ] as const) {
    for (const args of intrinsicInvocationArgumentCandidates(node, intrinsic, name, checker)) {
      const target = targetFor(args);
      const prototype = args[1];
      if (target && prototype) values.push({
        initializer: prototype,
        path: target.path,
        sourcePath: [],
      });
    }
  }
  return values;
}
