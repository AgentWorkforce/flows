import ts from 'typescript';
import type {
  AssignedSource,
  BindingPathSegment,
} from './shipped-source-binding-targets.js';
import { returnedExpressions } from './shipped-source-return-values.js';

export type StaticIterationSources = (
  expression: ts.Identifier,
  checker: ts.TypeChecker,
) => AssignedSource[];

interface ArrayCandidate {
  unknownSpreads: ts.Expression[];
  values: Array<ts.Expression | undefined>;
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

function branches(expression: ts.Expression): readonly ts.Expression[] | undefined {
  expression = unwrap(expression);
  if (ts.isConditionalExpression(expression)) return [expression.whenTrue, expression.whenFalse];
  if (ts.isBinaryExpression(expression)
    && (expression.operatorToken.kind === ts.SyntaxKind.CommaToken
      || expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return [expression.left, expression.right];
  }
  return ts.isAwaitExpression(expression) ? [expression.expression] : undefined;
}

function directVariableSources(
  expression: ts.Identifier,
  checker: ts.TypeChecker,
): AssignedSource[] {
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol) return [];
  return symbol.declarations
    ?.filter(ts.isVariableDeclaration)
    .flatMap(declaration => declaration.initializer
      ? [{ initializer: declaration.initializer, path: [] }]
      : []) ?? [];
}

function expressionSegment(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): BindingPathSegment | undefined {
  expression = unwrap(expression);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  const type = checker.getTypeAtLocation(expression);
  if (type.isStringLiteral()) return type.value;
  return (type.flags & ts.TypeFlags.NumberLiteral) !== 0
    ? (type as ts.NumberLiteralType).value
    : undefined;
}

function propertySegment(
  name: ts.PropertyName,
  checker: ts.TypeChecker,
): BindingPathSegment | undefined {
  if (ts.isIdentifier(name)) return name.text;
  return ts.isComputedPropertyName(name)
    ? expressionSegment(name.expression, checker)
    : expressionSegment(name, checker);
}

function expressionValues(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ts.Expression[] {
  expression = unwrap(expression);
  if (!ts.isCallExpression(expression)) return [expression];
  const symbol = checker.getSymbolAtLocation(unwrap(expression.expression));
  if (symbol && seen.has(symbol)) return [];
  const declaration = checker.getResolvedSignature(expression)?.declaration;
  if (!declaration || !ts.isFunctionLike(declaration) || !('body' in declaration)) return [];
  const nextSeen = symbol ? new Set(seen).add(symbol) : new Set(seen);
  return returnedExpressions(declaration.body).flatMap(value => {
    const wrapped = branches(value);
    return wrapped
      ? wrapped.flatMap(branch => expressionValues(branch, checker, new Set(nextSeen)))
      : [value];
  });
}

function memberSeen(
  root: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): Set<ts.Symbol> | undefined {
  root = unwrap(root);
  if (!ts.isIdentifier(root)) return new Set(seen);
  const symbol = checker.getSymbolAtLocation(root);
  if (!symbol) return new Set(seen);
  return seen.has(symbol) ? undefined : new Set(seen).add(symbol);
}

function canonicalArrayIndex(segment: BindingPathSegment): number | undefined {
  if (typeof segment === 'number') {
    return Number.isInteger(segment) && segment >= 0 ? segment : undefined;
  }
  return /^(?:0|[1-9]\d*)$/u.test(segment) ? Number(segment) : undefined;
}

function memberPath(
  expression: ts.Expression,
  checker: ts.TypeChecker,
): { path: BindingPathSegment[]; root: ts.Expression } | undefined {
  expression = unwrap(expression);
  if (ts.isPropertyAccessExpression(expression)) {
    const parent = memberPath(expression.expression, checker)
      ?? { path: [], root: expression.expression };
    return { path: [...parent.path, expression.name.text], root: parent.root };
  }
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression) {
    const segment = expressionSegment(expression.argumentExpression, checker);
    if (segment === undefined) return undefined;
    const parent = memberPath(expression.expression, checker)
      ?? { path: [], root: expression.expression };
    return { path: [...parent.path, segment], root: parent.root };
  }
  return undefined;
}

function arrayCandidates(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  sources: StaticIterationSources,
  seen: Set<ts.Symbol>,
): ArrayCandidate[] {
  expression = unwrap(expression);
  const wrapped = branches(expression);
  if (wrapped) return wrapped.flatMap(branch =>
    arrayCandidates(branch, checker, sources, new Set(seen)));
  if (ts.isArrayLiteralExpression(expression)) {
    let candidates: ArrayCandidate[] = [{ unknownSpreads: [], values: [] }];
    for (const element of expression.elements) {
      if (ts.isOmittedExpression(element)) {
        candidates.forEach(candidate => candidate.values.push(undefined));
        continue;
      }
      if (!ts.isSpreadElement(element)) {
        candidates.forEach(candidate => candidate.values.push(element));
        continue;
      }
      const spread = arrayCandidates(element.expression, checker, sources, new Set(seen));
      candidates = spread.length === 0
        ? candidates.map(candidate => ({
            unknownSpreads: [...candidate.unknownSpreads, element.expression],
            values: [...candidate.values],
          }))
        : candidates.flatMap(prefix => spread.map(candidate => ({
            unknownSpreads: [...prefix.unknownSpreads, ...candidate.unknownSpreads],
            values: [...prefix.values, ...candidate.values],
          })));
    }
    return candidates;
  }
  if (ts.isCallExpression(expression)) {
    const symbol = checker.getSymbolAtLocation(unwrap(expression.expression));
    if (symbol && seen.has(symbol)) return [];
    const nextSeen = symbol ? new Set(seen).add(symbol) : new Set(seen);
    return expressionValues(expression, checker, seen).flatMap(value =>
      arrayCandidates(value, checker, sources, new Set(nextSeen)));
  }
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression
    && expressionSegment(expression.argumentExpression, checker) === undefined) {
    return allObjectMemberValues(expression.expression, checker, sources, new Set(seen))
      .flatMap(value => arrayCandidates(value, checker, sources, new Set(seen)));
  }
  const member = memberPath(expression, checker);
  if (member) {
    const nextSeen = memberSeen(member.root, checker, seen);
    if (!nextSeen) return [];
    return expressionValues(member.root, checker, nextSeen).flatMap(root => valuesAtPath(
      root,
      member.path,
      checker,
      sources,
      new Set(seen),
    )).flatMap(value => arrayCandidates(value, checker, sources, new Set(nextSeen)));
  }
  if (!ts.isIdentifier(expression)) return [];
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return [];
  const nextSeen = new Set(seen).add(symbol);
  return sources(expression, checker).flatMap(source => {
    const values = valuesAtPath(
      source.initializer,
      source.path,
      checker,
      sources,
      new Set(nextSeen),
    );
    if (source.iterationValue) {
      return values.map(value => ({ unknownSpreads: [], values: [value] }));
    }
    if (source.rest?.kind === 'object') return [];
    const candidates = values.flatMap(value =>
      arrayCandidates(value, checker, sources, new Set(nextSeen)));
    const restStart = source.rest?.kind === 'array' ? source.rest.start : undefined;
    return restStart !== undefined
      ? candidates.map(candidate => ({
          ...candidate,
          values: candidate.unknownSpreads.length > 0
            ? candidate.values
            : candidate.values.slice(restStart),
        }))
      : candidates;
  });
}

function arrayValues(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  sources: StaticIterationSources,
  seen: Set<ts.Symbol>,
): ts.Expression[] {
  return arrayCandidates(expression, checker, sources, seen)
    .flatMap(candidate => [
      ...candidate.values.filter((value): value is ts.Expression => value !== undefined),
      ...candidate.unknownSpreads,
    ]);
}

function objectMemberValues(
  expression: ts.Expression,
  segment: BindingPathSegment,
  checker: ts.TypeChecker,
  sources: StaticIterationSources,
  seen: Set<ts.Symbol>,
): ts.Expression[] {
  expression = unwrap(expression);
  if (ts.isCallExpression(expression)) {
    return expressionValues(expression, checker, seen).flatMap(value =>
      objectMemberValues(value, segment, checker, sources, new Set(seen)));
  }
  const wrapped = branches(expression);
  if (wrapped) return wrapped.flatMap(branch =>
    objectMemberValues(branch, segment, checker, sources, new Set(seen)));
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.flatMap(member => {
      if (ts.isSpreadAssignment(member)) {
        return objectMemberValues(member.expression, segment, checker, sources, new Set(seen));
      }
      if (!member.name || propertySegment(member.name, checker) !== segment) return [];
      if (ts.isPropertyAssignment(member)) return [member.initializer];
      if (ts.isShorthandPropertyAssignment(member)) return [member.name];
      return [];
    });
  }
  if (!ts.isIdentifier(expression)) return [];
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return [];
  const nextSeen = new Set(seen).add(symbol);
  return sources(expression, checker).flatMap(source => {
    if (source.rest) return [];
    return valuesAtPath(
      source.initializer,
      [...source.path, segment],
      checker,
      sources,
      new Set(nextSeen),
    );
  });
}

function allObjectMemberValues(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  sources: StaticIterationSources,
  seen: Set<ts.Symbol>,
): ts.Expression[] {
  expression = unwrap(expression);
  const wrapped = branches(expression);
  if (wrapped) return wrapped.flatMap(branch =>
    allObjectMemberValues(branch, checker, sources, new Set(seen)));
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.flatMap(member => {
      if (ts.isSpreadAssignment(member)) {
        return allObjectMemberValues(member.expression, checker, sources, new Set(seen));
      }
      if (ts.isPropertyAssignment(member)) return [member.initializer];
      return ts.isShorthandPropertyAssignment(member) ? [member.name] : [];
    });
  }
  if (ts.isCallExpression(expression)) {
    return expressionValues(expression, checker, seen).flatMap(value =>
      allObjectMemberValues(value, checker, sources, new Set(seen)));
  }
  if (!ts.isIdentifier(expression)) return [];
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return [];
  const nextSeen = new Set(seen).add(symbol);
  return sources(expression, checker).flatMap(source => {
    if (source.rest) return [];
    return valuesAtPath(
      source.initializer,
      source.path,
      checker,
      sources,
      new Set(nextSeen),
    ).flatMap(value => allObjectMemberValues(value, checker, sources, new Set(nextSeen)));
  });
}

function valuesAtPath(
  expression: ts.Expression,
  path: readonly BindingPathSegment[],
  checker: ts.TypeChecker,
  sources: StaticIterationSources,
  seen: Set<ts.Symbol>,
): ts.Expression[] {
  if (path.length === 0) return [expression];
  const [head, ...tail] = path;
  const index = canonicalArrayIndex(head!);
  const values = [
    ...objectMemberValues(expression, head!, checker, sources, seen),
    ...(index === undefined
      ? []
      : arrayCandidates(expression, checker, sources, seen)
        .flatMap(candidate => {
          const selected = candidate.values[index] ? [candidate.values[index]!] : [];
          return candidate.unknownSpreads.length === 0 ? selected : [
            ...selected,
            ...candidate.values.filter((value): value is ts.Expression => value !== undefined),
            ...candidate.unknownSpreads,
          ];
        })),
  ];
  return tail.length === 0 ? values : values.flatMap(value =>
    valuesAtPath(value, tail, checker, sources, new Set(seen)));
}

export function staticForOfValues(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  sources: StaticIterationSources = directVariableSources,
  seen = new Set<ts.Symbol>(),
): ts.Expression[] {
  return arrayValues(expression, checker, sources, seen);
}

export function staticForInKeys(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  sources: StaticIterationSources = directVariableSources,
  seen = new Set<ts.Symbol>(),
): ts.Expression[] {
  expression = unwrap(expression);
  const wrapped = branches(expression);
  if (wrapped) return wrapped.flatMap(branch =>
    staticForInKeys(branch, checker, sources, new Set(seen)));
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.flatMap(member => {
      if (ts.isSpreadAssignment(member)) {
        return staticForInKeys(member.expression, checker, sources, new Set(seen));
      }
      if (!member.name) return [];
      return [ts.isComputedPropertyName(member.name) ? member.name.expression : member.name];
    });
  }
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression
    && expressionSegment(expression.argumentExpression, checker) === undefined) {
    return allObjectMemberValues(expression.expression, checker, sources, new Set(seen))
      .flatMap(value => staticForInKeys(value, checker, sources, new Set(seen)));
  }
  const member = memberPath(expression, checker);
  if (member) {
    const nextSeen = memberSeen(member.root, checker, seen);
    if (!nextSeen) return [];
    return expressionValues(member.root, checker, nextSeen).flatMap(root => valuesAtPath(
      root,
      member.path,
      checker,
      sources,
      new Set(seen),
    )).flatMap(value => staticForInKeys(value, checker, sources, new Set(nextSeen)));
  }
  if (!ts.isIdentifier(expression)) return [];
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return [];
  const nextSeen = new Set(seen).add(symbol);
  return sources(expression, checker).flatMap(source => {
    const values = valuesAtPath(
      source.initializer,
      source.path,
      checker,
      sources,
      new Set(nextSeen),
    );
    const keys = values.flatMap(value =>
      staticForInKeys(value, checker, sources, new Set(nextSeen)));
    const rest = source.rest;
    if (rest?.kind === 'array') return [];
    return rest?.kind === 'object'
      ? keys.filter(key => {
          const name = expressionSegment(key, checker);
          return name === undefined || !rest.excluded.includes(String(name));
        })
      : keys;
  });
}
