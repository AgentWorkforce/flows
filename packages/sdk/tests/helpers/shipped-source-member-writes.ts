import ts from 'typescript';
import {
  assignmentMayStoreRight,
  bindingSource,
  type BindingRest,
  type BindingPathSegment,
} from './shipped-source-binding-provenance.js';
import {
  aggregateExpressionValue,
  aggregateValueAtPath,
  assignedValues,
  bindingDefaultValues,
  staticPropertySegment,
  wrappedExpressionBranches,
} from './shipped-source-binding-values.js';
import { intrinsicInvocationArgumentCandidates } from './shipped-source-intrinsic-invocations.js';
import { returnedExpressions } from './shipped-source-return-values.js';

export interface ReflectiveMemberAssignedSource {
  initializer: ts.Expression;
  path: BindingPathSegment[];
  sourcePath: BindingPathSegment[];
}

interface MemberAssignedSource extends ReflectiveMemberAssignedSource {
  rest?: BindingRest;
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

function canonicalArrayIndex(segment: BindingPathSegment): number | undefined {
  if (typeof segment === 'number') return Number.isInteger(segment) && segment >= 0 ? segment : undefined;
  return /^(?:0|[1-9]\d*)$/u.test(segment) ? Number(segment) : undefined;
}

function memberAssignmentPaths(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): Array<{ path: BindingPathSegment[]; symbol: ts.Symbol }> {
  expression = unwrap(expression);
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
    return returnedExpressions(declaration.body).flatMap(returned => {
      const returnedMember = memberPath(returned, checker);
      if (!returnedMember) return memberAssignmentPaths(returned, checker, new Set(seen));
      const parameterIndex = declaration.parameters.findIndex(parameter =>
        ts.isIdentifier(parameter.name)
        && checker.getSymbolAtLocation(parameter.name) === returnedMember.symbol);
      const argument = parameterIndex < 0 ? undefined : expression.arguments[parameterIndex];
      return argument && !ts.isSpreadElement(argument)
        ? memberAssignmentPaths(argument, checker, new Set(seen))
          .map(parent => ({ ...parent, path: [...parent.path, ...returnedMember.path] }))
        : [];
    });
  }
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return [];
  const segment = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : expression.argumentExpression
      ? staticPropertySegment(expression.argumentExpression, checker, new Set(seen))
      : undefined;
  return segment === undefined ? [] : memberAssignmentPaths(expression.expression, checker, seen)
    .map(parent => ({ ...parent, path: [...parent.path, segment] }));
}

function memberPath(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): { path: BindingPathSegment[]; symbol: ts.Symbol } | undefined {
  expression = unwrap(expression);
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    return symbol ? { path: [], symbol } : undefined;
  }
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return undefined;
  const parent = memberPath(expression.expression, checker);
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
  const aggregate = aggregateExpressionValue(expression, checker, new Set(seen));
  if (aggregate) {
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
      } else if (ts.isPropertyAssignment(property)
        && (ts.isArrowFunction(property.initializer) || ts.isFunctionExpression(property.initializer))) {
        values.push(...returnedExpressions(property.initializer.body));
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

function memberAssignedSourcesAtTarget(
  target: ts.Expression,
  value: ts.Expression,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  sourcePath: BindingPathSegment[] = [],
): MemberAssignedSource[] {
  target = unwrap(target);
  const member = memberPath(target, checker);
  if (member?.symbol === symbol && member.path.length > 0) {
    return [{ initializer: value, path: member.path, sourcePath }];
  }
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return [
      ...memberAssignedSourcesAtTarget(target.left, value, symbol, checker, sourcePath),
      ...memberAssignedSourcesAtTarget(target.left, target.right, symbol, checker),
    ];
  }
  if (ts.isArrayLiteralExpression(target)) return target.elements.flatMap((element, index) => {
    if (ts.isOmittedExpression(element)) return [];
    if (!ts.isSpreadElement(element)) {
      return memberAssignedSourcesAtTarget(element, value, symbol, checker, [...sourcePath, index]);
    }
    return memberAssignedSourcesAtTarget(element.expression, value, symbol, checker, sourcePath)
      .flatMap(source => {
        if (source.initializer !== value) return source;
        const relativePath = source.sourcePath.slice(sourcePath.length);
        if (relativePath.length === 0) return [{
          ...source,
          sourcePath: [...sourcePath],
          rest: {
            kind: 'array' as const,
            start: index + (source.rest?.kind === 'array' ? source.rest.start : 0),
          },
        }];
        const [first, ...tail] = relativePath;
        const relative = canonicalArrayIndex(first!);
        return relative === undefined ? [] : [{
          ...source,
          sourcePath: [...sourcePath, index + relative, ...tail],
        }];
      });
  });
  if (!ts.isObjectLiteralExpression(target)) return [];
  const excluded: string[] = [];
  return target.properties.flatMap(property => {
    if (ts.isSpreadAssignment(property)) {
      return memberAssignedSourcesAtTarget(property.expression, value, symbol, checker, sourcePath)
        .map(source => source.initializer !== value || source.sourcePath.length > sourcePath.length
          ? source
          : {
              ...source,
              sourcePath: [...sourcePath],
              rest: { excluded: [...excluded], kind: 'object' as const },
            });
    }
    const segment = propertyName(property.name, checker);
    if (segment === undefined) return [];
    const assignmentTarget = ts.isPropertyAssignment(property) ? property.initializer
      : ts.isShorthandPropertyAssignment(property) ? property.name : undefined;
    if (!assignmentTarget) return [];
    excluded.push(segment);
    return memberAssignedSourcesAtTarget(
      assignmentTarget,
      value,
      symbol,
      checker,
      [...sourcePath, segment],
    );
  });
}

const memberAssignedSourceCache = new WeakMap<
  ts.TypeChecker,
  WeakMap<ts.Symbol, MemberAssignedSource[]>
>();

function memberAssignedSources(symbol: ts.Symbol, checker: ts.TypeChecker): MemberAssignedSource[] {
  let checkerCache = memberAssignedSourceCache.get(checker);
  if (!checkerCache) {
    checkerCache = new WeakMap();
    memberAssignedSourceCache.set(checker, checkerCache);
  }
  const cached = checkerCache.get(symbol);
  if (cached) return cached;
  const source = symbol.valueDeclaration?.getSourceFile() ?? symbol.declarations?.[0]?.getSourceFile();
  if (!source) return [];
  const values: MemberAssignedSource[] = [];
  checkerCache.set(symbol, values);
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && assignmentMayStoreRight(node.operatorToken.kind)) {
      values.push(...memberAssignedSourcesAtTarget(node.left, node.right, symbol, checker));
    }
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
  const target = memberPath(expression, checker);
  if (!target || target.path.length === 0) return [];
  return memberAssignedSources(target.symbol, checker).flatMap(source => {
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
    let remainder = target.path.slice(source.path.length);
    if (source.rest?.kind === 'object') {
      const name = remainder[0];
      if (name === undefined || source.rest.excluded.includes(String(name))) return [];
    }
    if (source.rest?.kind === 'array') {
      const index = remainder[0] === undefined ? undefined : canonicalArrayIndex(remainder[0]);
      if (index === undefined) return [];
      remainder = [source.rest.start + index, ...remainder.slice(1)];
    }
    if (remainder.length === 0) return [{ value: sourceValue.value, auditable: false as const }];
    const candidate = aggregateValueAtPath(
      sourceValue.value,
      remainder,
      checker,
      new Set(seen).add(target.symbol),
    );
    return candidate ? [{ value: candidate.value, auditable: false as const }] : [];
  });
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
