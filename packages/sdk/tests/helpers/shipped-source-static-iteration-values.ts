import ts from 'typescript';
import type {
  AssignedSource,
  BindingPathSegment,
} from './shipped-source-binding-targets.js';

export type StaticIterationSources = (
  expression: ts.Identifier,
  checker: ts.TypeChecker,
) => AssignedSource[];

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
  if (ts.isIdentifier(expression) || ts.isStringLiteralLike(expression)) return expression.text;
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
  return ts.isComputedPropertyName(name)
    ? expressionSegment(name.expression, checker)
    : expressionSegment(name, checker);
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

function arrayValues(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  sources: StaticIterationSources,
  seen: Set<ts.Symbol>,
): ts.Expression[] {
  expression = unwrap(expression);
  const wrapped = branches(expression);
  if (wrapped) return wrapped.flatMap(branch => arrayValues(branch, checker, sources, new Set(seen)));
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap(element => {
      if (ts.isOmittedExpression(element)) return [];
      return ts.isSpreadElement(element)
        ? arrayValues(element.expression, checker, sources, new Set(seen))
        : [element];
    });
  }
  const member = memberPath(expression, checker);
  if (member) return valuesAtPath(
    member.root,
    member.path,
    checker,
    sources,
    new Set(seen),
  ).flatMap(value => arrayValues(value, checker, sources, new Set(seen)));
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
    if (source.rest?.kind === 'object') return [];
    const elements = values.flatMap(value => arrayValues(value, checker, sources, new Set(nextSeen)));
    return source.rest?.kind === 'array' ? elements.slice(source.rest.start) : elements;
  });
}

function objectMemberValues(
  expression: ts.Expression,
  segment: BindingPathSegment,
  checker: ts.TypeChecker,
  sources: StaticIterationSources,
  seen: Set<ts.Symbol>,
): ts.Expression[] {
  expression = unwrap(expression);
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
      : arrayValues(expression, checker, sources, seen).slice(index, index + 1)),
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
  const member = memberPath(expression, checker);
  if (member) return valuesAtPath(
    member.root,
    member.path,
    checker,
    sources,
    new Set(seen),
  ).flatMap(value => staticForInKeys(value, checker, sources, new Set(seen)));
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
