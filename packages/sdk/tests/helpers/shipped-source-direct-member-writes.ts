import ts from 'typescript';
import {
  assignmentMayStoreRight,
  assignedSourceMayPrecedeReference,
  assignedSources,
  bindingSource,
  staticIterationSources,
  type BindingPathSegment,
  type BindingRest,
} from './shipped-source-binding-provenance.js';
import {
  aggregateValueAtPath,
  staticPropertySegment,
  wrappedExpressionBranches,
} from './shipped-source-binding-values.js';
import { localCallTargetPaths } from './shipped-source-local-call-targets.js';
import { staticPropertySegments } from './shipped-source-static-property-segments.js';
import {
  staticForInKeys,
  staticForOfValues,
} from './shipped-source-static-iteration-values.js';

interface DirectMemberAssignedSource {
  dynamic?: true;
  initializer: ts.Expression;
  path: BindingPathSegment[];
  sourcePath: BindingPathSegment[];
  rest?: BindingRest;
}

interface IndexedDirectMemberAssignedSource extends DirectMemberAssignedSource {
  symbol: ts.Symbol;
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

function propertyName(name: ts.PropertyName | undefined, checker: ts.TypeChecker): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (!ts.isComputedPropertyName(name)) return undefined;
  if (ts.isStringLiteralLike(name.expression)) return name.expression.text;
  const segment = staticPropertySegment(name.expression, checker, new Set());
  return segment === undefined ? undefined : String(segment);
}

function canonicalArrayIndex(segment: BindingPathSegment): number | undefined {
  if (typeof segment === 'number') return Number.isInteger(segment) && segment >= 0 && segment <= 4_294_967_294 ? segment : undefined;
  return /^(?:0|[1-9]\d*)$/u.test(segment)
    && (segment.length < 10 || (segment.length === 10 && segment <= '4294967294'))
    ? Number(segment)
    : undefined;
}

export function directMemberPaths(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
  callerPath: readonly BindingPathSegment[] = [],
): Array<{ path: BindingPathSegment[]; symbol: ts.Symbol }> {
  expression = unwrap(expression);
  const branches = wrappedExpressionBranches(expression);
  if (branches) return branches.flatMap(candidate =>
    directMemberPaths(candidate, checker, new Set(seen), callerPath));
  if (ts.isBinaryExpression(expression) && assignmentMayStoreRight(expression.operatorToken.kind)) {
    const candidates = expression.operatorToken.kind === ts.SyntaxKind.EqualsToken
      ? [expression.right]
      : [expression.left, expression.right];
    return candidates.flatMap(candidate =>
      directMemberPaths(candidate, checker, new Set(seen), callerPath));
  }
  if (expression.kind === ts.SyntaxKind.ThisKeyword) {
    for (let current: ts.Node | undefined = expression.parent; current; current = current.parent) {
      if (!ts.isVariableDeclaration(current) || !ts.isIdentifier(current.name)
        || !current.initializer || expression.getStart() < current.initializer.getStart()
        || expression.getEnd() > current.initializer.getEnd()) continue;
      const symbol = checker.getSymbolAtLocation(current.name);
      return symbol ? [{ path: [...callerPath], symbol }] : [];
    }
    return [];
  }
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol) return [];
    const paths = [{ path: [...callerPath], symbol }];
    if (seen.has(symbol)) return paths;
    const nextSeen = new Set(seen).add(symbol);
    const add = (candidate: ts.Expression | undefined, suffix: BindingPathSegment[] = []): void => {
      if (!candidate) return;
      const candidates = wrappedExpressionBranches(candidate) ?? [candidate];
      paths.push(...candidates.flatMap(value => directMemberPaths(
        value,
        checker,
        new Set(nextSeen),
        [...suffix, ...callerPath],
      )));
    };
    const binding = symbol.declarations?.find(ts.isBindingElement);
    if (binding) {
      const source = bindingSource(binding, checker, new Set(nextSeen));
      if (source) {
        add(source.initializer, source.path);
        const candidate = source.path.length === 0
          ? { value: source.initializer }
          : aggregateValueAtPath(source.initializer, source.path, checker, new Set(nextSeen));
        add(candidate?.value);
      }
      add(binding.initializer);
    }
    const variable = symbol.declarations?.find(ts.isVariableDeclaration);
    for (const source of assignedSources(symbol, checker)) {
      if (source.rest) continue;
      const candidate = source.path.length === 0
        ? { value: source.initializer }
        : aggregateValueAtPath(source.initializer, source.path, checker, new Set(nextSeen));
      add(candidate?.value);
    }
    add(variable?.initializer);
    return paths;
  }
  if (ts.isCallExpression(expression)) {
    return localCallTargetPaths(
      expression,
      checker,
      seen,
      (candidate, nextSeen) => directMemberPaths(candidate, checker, nextSeen),
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
  return directMemberPaths(expression.expression, checker, seen, [segment, ...callerPath]);
}

function directWriteMemberPaths(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): Array<{ path: BindingPathSegment[]; symbol: ts.Symbol }> {
  let paths = directMemberPaths(expression, checker);
  expression = unwrap(expression);
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return paths;
  const segments = ts.isPropertyAccessExpression(expression)
    ? [expression.name.text]
    : expression.argumentExpression
      ? staticPropertySegments(
          expression.argumentExpression,
          checker,
          new Set(),
          (candidate, seen) => directAssignedMemberValues(candidate, checker, seen)
            .map(value => value.value),
        )
      : [];
  if (segments.length === 0) return paths;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    paths = segments.flatMap(segment => directMemberPaths(expression.expression, checker)
      .map(parent => ({ ...parent, path: [...parent.path, segment] })));
  }
  for (const segment of segments) {
    for (const parent of directMemberAliasPaths(expression.expression, checker)) {
      paths.push({ ...parent, path: [...parent.path, segment] });
    }
  }
  return paths;
}

export function directMemberAliasPaths(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): Array<{ path: BindingPathSegment[]; symbol: ts.Symbol }> {
  const aliases: Array<{ path: BindingPathSegment[]; symbol: ts.Symbol }> = [];
  for (const member of directMemberPaths(expression, checker)) {
    if (member.path.length === 0) continue;
    const variable = member.symbol.declarations?.find(ts.isVariableDeclaration);
    const binding = member.symbol.declarations?.find(ts.isBindingElement);
    const candidates: Array<{ expression: ts.Expression; path: BindingPathSegment[] }> = [];
    if (variable?.initializer) candidates.push({ expression: variable.initializer, path: member.path });
    for (const source of assignedSources(member.symbol, checker)) {
      if (!source.rest) candidates.push({
        expression: source.initializer,
        path: [...source.path, ...member.path],
      });
    }
    if (binding) {
      const source = bindingSource(binding, checker, new Set([member.symbol]));
      if (source) candidates.push({
        expression: source.initializer,
        path: [...source.path, ...member.path],
      });
    }
    for (const candidate of candidates) {
      const value = aggregateValueAtPath(candidate.expression, candidate.path, checker, new Set([member.symbol]));
      if (value) aliases.push(...directMemberPaths(value.value, checker, new Set([member.symbol])));
    }
    for (const source of directMemberAssignedSources(member.symbol, checker)) {
      if (source.path.length > member.path.length
        || source.path.some((segment, index) => String(segment) !== String(member.path[index]))) continue;
      const sourceValue = source.sourcePath.length === 0
        ? { value: source.initializer }
        : aggregateValueAtPath(source.initializer, source.sourcePath, checker, new Set([member.symbol]));
      if (!sourceValue) continue;
      const remainder = member.path.slice(source.path.length);
      const value = remainder.length === 0
        ? sourceValue
        : aggregateValueAtPath(sourceValue.value, remainder, checker, new Set([member.symbol]));
      if (value) aliases.push(...directMemberPaths(value.value, checker, new Set([member.symbol])));
    }
  }
  return aliases;
}

export function directMemberPath(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): { path: BindingPathSegment[]; symbol: ts.Symbol } | undefined {
  return directMemberPaths(expression, checker)[0];
}

function sourcesAtTarget(
  target: ts.Expression,
  value: ts.Expression,
  checker: ts.TypeChecker,
  sourcePath: BindingPathSegment[] = [],
): IndexedDirectMemberAssignedSource[] {
  target = unwrap(target);
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return [
      ...sourcesAtTarget(target.left, value, checker, sourcePath),
      ...sourcesAtTarget(target.left, target.right, checker),
    ];
  }
  const members = directWriteMemberPaths(target, checker).filter(member => member.path.length > 0);
  const dynamicParents = ts.isElementAccessExpression(target) && target.argumentExpression
    && staticPropertySegment(target.argumentExpression, checker, new Set()) === undefined
    ? directMemberPaths(target.expression, checker)
    : [];
  if (members.length > 0 || dynamicParents.length > 0) {
    return [
      ...members.map(member => ({
        initializer: value,
        path: member.path,
        sourcePath,
        symbol: member.symbol,
      })),
      ...dynamicParents.map(parent => ({
        dynamic: true as const,
        initializer: value,
        path: parent.path,
        sourcePath,
        symbol: parent.symbol,
      })),
    ];
  }
  if (ts.isArrayLiteralExpression(target)) return target.elements.flatMap((element, index) => {
    if (ts.isOmittedExpression(element)) return [];
    if (!ts.isSpreadElement(element)) {
      return sourcesAtTarget(element, value, checker, [...sourcePath, index]);
    }
    return sourcesAtTarget(element.expression, value, checker, sourcePath).flatMap(source => {
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
      return sourcesAtTarget(property.expression, value, checker, sourcePath)
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
    return sourcesAtTarget(assignmentTarget, value, checker, [...sourcePath, segment]);
  });
}

const sourceCache = new WeakMap<
  ts.TypeChecker,
  WeakMap<ts.SourceFile, Map<ts.Symbol, DirectMemberAssignedSource[]>>
>();

function directMemberSourceIndex(
  source: ts.SourceFile,
  checker: ts.TypeChecker,
): Map<ts.Symbol, DirectMemberAssignedSource[]> {
  let checkerCache = sourceCache.get(checker);
  if (!checkerCache) {
    checkerCache = new WeakMap();
    sourceCache.set(checker, checkerCache);
  }
  const cached = checkerCache.get(source);
  if (cached) return cached;
  const index = new Map<ts.Symbol, DirectMemberAssignedSource[]>();
  checkerCache.set(source, index);
  const add = (target: ts.Expression, value: ts.Expression): void => {
    for (const { symbol, ...assigned } of sourcesAtTarget(target, value, checker)) {
      const values = index.get(symbol) ?? [];
      values.push(assigned);
      index.set(symbol, values);
    }
  };
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node) && assignmentMayStoreRight(node.operatorToken.kind)) {
      add(node.left, node.right);
    }
    if (ts.isForOfStatement(node) && !ts.isVariableDeclarationList(node.initializer)) {
      for (const value of staticForOfValues(node.expression, checker, staticIterationSources)) {
        add(node.initializer, value);
      }
    }
    if (ts.isForInStatement(node) && !ts.isVariableDeclarationList(node.initializer)) {
      for (const key of staticForInKeys(node.expression, checker, staticIterationSources)) {
        add(node.initializer, key);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return index;
}

function directMemberAssignedSources(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): DirectMemberAssignedSource[] {
  const source = symbol.valueDeclaration?.getSourceFile() ?? symbol.declarations?.[0]?.getSourceFile();
  if (!source) return [];
  return directMemberSourceIndex(source, checker).get(symbol) ?? [];
}

export function directAssignedMemberValues(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): Array<{ value: ts.Expression; auditable: false }> {
  return directMemberPaths(expression, checker).flatMap(target => {
    if (target.path.length === 0 || seen.has(target.symbol)) return [];
    return directMemberAssignedSources(target.symbol, checker).flatMap(source => {
      if (!assignedSourceMayPrecedeReference(
        { initializer: source.initializer, path: [] },
        target.symbol,
        expression,
      )) return [];
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
      if (source.dynamic) return remainder.length === 1
        ? [{ value: sourceValue.value, auditable: false as const }]
        : [];
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
  });
}
