import ts from 'typescript';
import {
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
import {
  bindingNamePaths,
  canonicalArrayIndex,
  isStaticallyUndefined,
  localCallArgumentCandidates,
} from './shipped-source-local-call-arguments.js';
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

function memberPathsAtActual(
  actual: ts.Expression,
  sourcePath: readonly BindingPathSegment[],
  suffix: readonly BindingPathSegment[],
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): Array<{ path: BindingPathSegment[]; symbol: ts.Symbol }> {
  const value = sourcePath.length === 0
    ? { value: actual }
    : aggregateValueAtPath(actual, sourcePath, checker, new Set(seen));
  return value
    ? memberAssignmentPaths(value.value, checker, new Set(seen))
      .map(parent => ({ ...parent, path: [...parent.path, ...suffix] }))
    : [];
}

function memberAssignmentPaths(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): Array<{ path: BindingPathSegment[]; symbol: ts.Symbol }> {
  expression = unwrap(expression);
  const branches = wrappedExpressionBranches(expression);
  if (branches) return branches.flatMap(branch =>
    memberAssignmentPaths(branch, checker, new Set(seen)));
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol) return [];
    const paths = [{ path: [] as BindingPathSegment[], symbol }];
    if (seen.has(symbol)) return paths;
    seen.add(symbol);
    const binding = symbol.declarations?.find(ts.isBindingElement);
    if (binding) {
      const source = bindingSource(binding, checker, new Set(seen));
      if (source) {
        for (const parent of memberAssignmentPaths(source.initializer, checker, new Set(seen))) {
          paths.push({ ...parent, path: [...parent.path, ...source.path] });
        }
      }
      if (binding.initializer) {
        paths.push(...memberAssignmentPaths(binding.initializer, checker, new Set(seen)));
      }
    }
    for (const assigned of assignedValues(symbol, checker)) {
      paths.push(...memberAssignmentPaths(assigned, checker, new Set(seen)));
    }
    const variable = symbol.declarations?.find(ts.isVariableDeclaration);
    if (variable?.initializer) {
      paths.push(...memberAssignmentPaths(variable.initializer, checker, new Set(seen)));
    }
    return paths;
  }
  if (ts.isCallExpression(expression)) {
    const declaration = checker.getResolvedSignature(expression)?.declaration;
    if (!declaration || !ts.isFunctionLike(declaration) || !('body' in declaration)) return [];
    const actualCandidates = localCallArgumentCandidates(expression.arguments, checker);
    return actualCandidates.flatMap(actuals => returnedExpressions(declaration.body).flatMap(returned =>
      memberAssignmentPaths(returned, checker, new Set(seen)).flatMap(returnedMember => {
        const mapped = declaration.parameters.flatMap((parameter, parameterIndex) =>
          bindingNamePaths(parameter.name, returnedMember.symbol, checker).flatMap(formal => {
            if (parameter.dotDotDotToken) {
              const formalOffset = formal.path[0];
              const returnedOffset = returnedMember.path[0];
              const offset = formal.rest?.kind === 'array'
                ? returnedOffset
                : formalOffset ?? returnedOffset;
              const index = offset === undefined ? undefined : canonicalArrayIndex(offset);
              const sourcePath = formalOffset === undefined ? formal.path : formal.path.slice(1);
              const suffix = formalOffset === undefined
                ? returnedMember.path.slice(1)
                : returnedMember.path;
              const restStart = formal.rest?.kind === 'array' ? formal.rest.start : 0;
              const actual = index !== undefined
                ? actuals[parameterIndex + restStart + index]
                : undefined;
              return actual && !ts.isSpreadElement(actual)
                ? memberPathsAtActual(actual, sourcePath, suffix, checker, seen)
                : [];
            }
            const supplied = actuals[parameterIndex];
            const actual = !supplied || isStaticallyUndefined(supplied, checker)
              ? parameter.initializer
              : supplied;
            if (formal.rest?.kind === 'array') {
              const [offset, ...suffix] = returnedMember.path;
              const index = offset === undefined ? undefined : canonicalArrayIndex(offset);
              return actual && index !== undefined && !ts.isSpreadElement(actual)
                ? memberPathsAtActual(
                    actual,
                    [...formal.path, formal.rest.start + index],
                    suffix,
                    checker,
                    seen,
                  )
                : [];
            }
            if (formal.rest?.kind === 'object') {
              const [member, ...suffix] = returnedMember.path;
              return actual && member !== undefined
                && !formal.rest.excluded.includes(String(member))
                && !ts.isSpreadElement(actual)
                ? memberPathsAtActual(actual, [...formal.path, member], suffix, checker, seen)
                : [];
            }
            return actual && !ts.isSpreadElement(actual)
              ? memberPathsAtActual(actual, formal.path, returnedMember.path, checker, seen)
              : [];
          }));
        return mapped.length > 0 ? mapped : [returnedMember];
      })));
  }
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return [];
  const segment = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : expression.argumentExpression
      ? staticPropertySegment(expression.argumentExpression, checker, new Set(seen))
      : undefined;
  if (segment === undefined) return [];
  const paths = memberAssignmentPaths(expression.expression, checker, seen)
    .map(parent => ({ ...parent, path: [...parent.path, segment] }));
  paths.push(...directMemberAliasPaths(expression, checker));
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
