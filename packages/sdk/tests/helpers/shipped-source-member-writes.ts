import ts from 'typescript';
import {
  assignmentMayStoreRight,
  bindingSource,
  type BindingPathSegment,
} from './shipped-source-binding-provenance.js';
import { baseAggregateExpressionValues } from './shipped-source-base-aggregate-values.js';
import {
  aggregateValueAtPath,
  assignedValues,
  bindingDefaultValues,
  staticPropertySegment,
  wrappedExpressionBranches,
} from './shipped-source-binding-values.js';
import {
  directMemberAliasPaths,
  directAssignedMemberValues,
  directMemberPath,
} from './shipped-source-direct-member-writes.js';
import { intrinsicInvocationArgumentCandidates } from './shipped-source-intrinsic-invocations.js';
import { localCallTargetPaths } from './shipped-source-local-call-targets.js';
import { returnedExpressions } from './shipped-source-return-values.js';

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

function memberAssignmentPaths(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
  callerPath: readonly BindingPathSegment[] = [],
): Array<{ path: BindingPathSegment[]; symbol: ts.Symbol }> {
  expression = unwrap(expression);
  const branches = wrappedExpressionBranches(expression);
  if (branches) return branches.flatMap(branch =>
    memberAssignmentPaths(branch, checker, new Set(seen), callerPath));
  if (ts.isBinaryExpression(expression) && assignmentMayStoreRight(expression.operatorToken.kind)) {
    const candidates = expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ? [expression.right]
      : [expression.left, expression.right];
    return candidates.flatMap(candidate =>
      memberAssignmentPaths(candidate, checker, new Set(seen), callerPath));
  }
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol) return [];
    const paths = [{ path: [...callerPath], symbol }];
    if (seen.has(symbol)) return paths;
    seen.add(symbol);
    const binding = symbol.declarations?.find(ts.isBindingElement);
    if (binding) {
      const source = bindingSource(binding, checker, new Set(seen));
      if (source) {
        paths.push(...memberAssignmentPaths(
          source.initializer,
          checker,
          new Set(seen),
          [...source.path, ...callerPath],
        ));
      }
      if (binding.initializer) {
        paths.push(...memberAssignmentPaths(binding.initializer, checker, new Set(seen), callerPath));
      }
    }
    for (const assigned of assignedValues(symbol, checker)) {
      paths.push(...memberAssignmentPaths(assigned, checker, new Set(seen), callerPath));
    }
    const variable = symbol.declarations?.find(ts.isVariableDeclaration);
    if (variable?.initializer) {
      paths.push(...memberAssignmentPaths(variable.initializer, checker, new Set(seen), callerPath));
    }
    return paths;
  }
  if (ts.isCallExpression(expression)) {
    return localCallTargetPaths(
      expression,
      checker,
      seen,
      (candidate, nextSeen) => memberAssignmentPaths(candidate, checker, nextSeen),
      callerPath,
    );
  }
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return [];
  const segment = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : expression.argumentExpression
      ? staticPropertySegment(expression.argumentExpression, checker, new Set(seen))
      : undefined;
  if (segment === undefined) return [];
  const paths = memberAssignmentPaths(
    expression.expression,
    checker,
    seen,
    [segment, ...callerPath],
  );
  paths.push(...directMemberAliasPaths(expression, checker)
    .map(parent => ({ ...parent, path: [...parent.path, ...callerPath] })));
  return paths;
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
  const member = directMemberPath(expression, checker);
  if (member && seen.has(member.symbol)) return [];
  const candidateSeen = member ? new Set(seen).add(member.symbol) : seen;
  const values: ts.ObjectLiteralExpression[] = [];
  const add = (candidate: ts.Expression | undefined): void => {
    if (!candidate) return;
    for (const value of objectLiteralCandidates(candidate, checker, new Set(candidateSeen))) {
      if (!values.includes(value)) values.push(value);
    }
  };
  for (const aggregate of baseAggregateExpressionValues(expression, checker, new Set(seen))) {
    add(aggregate.value);
    for (const alternative of aggregate.alternatives ?? []) add(alternative);
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

function callableReturnValues(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ts.Expression[] {
  expression = unwrap(expression);
  if (ts.isArrowFunction(expression) || ts.isFunctionExpression(expression)) {
    return returnedExpressions(expression.body);
  }
  const branches = wrappedExpressionBranches(expression);
  if (branches) return branches.flatMap(branch =>
    callableReturnValues(branch, checker, new Set(seen)));
  const member = directMemberPath(expression, checker);
  if (member && seen.has(member.symbol)) return [];
  const candidateSeen = member ? new Set(seen).add(member.symbol) : seen;
  const values: ts.Expression[] = [];
  const add = (candidate: ts.Expression | undefined): void => {
    if (!candidate) return;
    for (const value of callableReturnValues(candidate, checker, new Set(candidateSeen))) {
      if (!values.includes(value)) values.push(value);
    }
  };
  for (const aggregate of baseAggregateExpressionValues(expression, checker, new Set(seen))) {
    add(aggregate.value);
  }
  if (!ts.isIdentifier(expression)) return values;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return values;
  seen.add(symbol);
  const declaration = symbol.declarations?.find(declaration =>
    ts.isFunctionLike(declaration) && 'body' in declaration && declaration.body);
  if (declaration && ts.isFunctionLike(declaration) && 'body' in declaration) {
    for (const value of returnedExpressions(declaration.body)) {
      if (!values.includes(value)) values.push(value);
    }
  }
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

function descriptorCallableValues(
  descriptor: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ts.Expression[] {
  const values: ts.Expression[] = [];
  for (const candidate of objectLiteralCandidates(descriptor, checker, seen)) {
    for (const property of candidate.properties) {
      const name = propertyName(property.name, checker);
      if (name === 'value' && ts.isPropertyAssignment(property)) {
        values.push(property.initializer);
        continue;
      }
      if (name !== 'get') continue;
      if (ts.isMethodDeclaration(property)) {
        values.push(...returnedExpressions(property.body));
      } else if (ts.isPropertyAssignment(property)) {
        values.push(...callableReturnValues(property.initializer, checker, new Set(seen)));
      }
    }
  }
  return values;
}

function descriptorMapProperties(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ts.PropertyAssignment[] {
  return objectLiteralCandidates(expression, checker, seen).flatMap(candidate =>
    candidate.properties.flatMap(property => {
      if (ts.isPropertyAssignment(property)) return [property];
      return ts.isSpreadAssignment(property)
        ? descriptorMapProperties(property.expression, checker, new Set(seen))
        : [];
    }));
}

const memberAssignedSourceCache = new WeakMap<
  ts.TypeChecker,
  WeakMap<ts.Symbol, ReflectiveMemberAssignedSource[]>
>();

function memberAssignedSources(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): ReflectiveMemberAssignedSource[] {
  let checkerCache = memberAssignedSourceCache.get(checker);
  if (!checkerCache) {
    checkerCache = new WeakMap();
    memberAssignedSourceCache.set(checker, checkerCache);
  }
  const cached = checkerCache.get(symbol);
  if (cached) return cached;
  const source = symbol.valueDeclaration?.getSourceFile() ?? symbol.declarations?.[0]?.getSourceFile();
  if (!source) return [];
  const values: ReflectiveMemberAssignedSource[] = [];
  checkerCache.set(symbol, values);
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) values.push(...reflectiveMemberAssignedSources(node, symbol, checker));
    ts.forEachChild(node, visit);
  };
  visit(source);
  return values;
}

export function assignedMemberValues(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): Array<{ value: ts.Expression; auditable: false }> {
  const direct = directAssignedMemberValues(expression, checker, new Set(seen));
  const target = directMemberPath(expression, checker);
  if (!target || target.path.length === 0) return direct;
  return [...direct, ...memberAssignedSources(target.symbol, checker).flatMap(source => {
    if (source.path.length > target.path.length
      || source.path.some((segment, index) => String(segment) !== String(target.path[index]))) return [];
    const sourceValue = source.sourcePath.length === 0
      ? { value: source.initializer }
      : aggregateValueAtPath(
          source.initializer,
          source.sourcePath,
          checker,
          new Set(seen).add(target.symbol),
        );
    if (!sourceValue) return [];
    const remainder = target.path.slice(source.path.length);
    if (remainder.length === 0) return [{ value: sourceValue.value, auditable: false as const }];
    const candidate = aggregateValueAtPath(
      sourceValue.value,
      remainder,
      checker,
      new Set(seen).add(target.symbol),
    );
    return candidate ? [{ value: candidate.value, auditable: false as const }] : [];
  })];
}

export function reflectiveMemberAssignedSources(
  node: ts.CallExpression,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): ReflectiveMemberAssignedSource[] {
  const values: ReflectiveMemberAssignedSource[] = [];
  const targetsFor = (args: readonly ts.Expression[]) => args[0]
    ? memberAssignmentPaths(args[0], checker).filter(target => target.symbol === symbol)
    : [];
  for (const args of intrinsicInvocationArgumentCandidates(node, 'Object', 'assign', checker)) {
    for (const target of targetsFor(args)) {
      values.push(...args.slice(1).map(initializer => ({
        initializer,
        path: target.path,
        sourcePath: [],
      })));
    }
  }
  for (const args of intrinsicInvocationArgumentCandidates(node, 'Reflect', 'set', checker)) {
    const segment = args[1]
      ? staticPropertySegment(args[1], checker, new Set([symbol]))
      : undefined;
    const initializer = args[2];
    if (segment === undefined || !initializer) continue;
    for (const target of targetsFor(args)) values.push({
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
      const segment = args[1]
        ? staticPropertySegment(args[1], checker, new Set([symbol]))
        : undefined;
      const descriptor = args[2];
      if (segment === undefined || !descriptor) continue;
      for (const target of targetsFor(args)) {
        const callables = descriptorCallableValues(descriptor, checker, new Set([symbol]));
        if (callables.length > 0) values.push(...callables.map(initializer => ({
          initializer,
          path: [...target.path, segment],
          sourcePath: [],
        })));
        else values.push({
          initializer: descriptor,
          path: [...target.path, segment],
          sourcePath: ['value'],
        });
      }
    }
  }
  for (const args of intrinsicInvocationArgumentCandidates(node, 'Object', 'defineProperties', checker)) {
    const descriptors = args[1];
    if (!descriptors) continue;
    for (const target of targetsFor(args)) {
      for (const property of descriptorMapProperties(descriptors, checker, new Set([symbol]))) {
        const segment = propertyName(property.name, checker);
        if (segment === undefined) continue;
        const callables = descriptorCallableValues(property.initializer, checker, new Set([symbol]));
        if (callables.length > 0) values.push(...callables.map(initializer => ({
          initializer,
          path: [...target.path, segment],
          sourcePath: [],
        })));
        else values.push({
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
      const prototype = args[1];
      if (!prototype) continue;
      for (const target of targetsFor(args)) values.push({
        initializer: prototype,
        path: target.path,
        sourcePath: [],
      });
    }
  }
  return values;
}
