import ts from 'typescript';

type BindingPathSegment = string | number;

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)
    ? name.expression.text
    : undefined;
}

function memberName(expression: ts.Expression): string | undefined {
  expression = unwrap(expression);
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression
    && ts.isStringLiteralLike(expression.argumentExpression)) return expression.argumentExpression.text;
  return undefined;
}

function memberReceiver(expression: ts.Expression): ts.Expression | undefined {
  expression = unwrap(expression);
  return ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
    ? expression.expression
    : undefined;
}

export function objectMemberValue(
  expression: ts.Expression,
  name: string,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): { value: ts.Expression; auditable: boolean; symbol?: ts.Symbol } | undefined {
  expression = unwrap(expression);
  if (ts.isObjectLiteralExpression(expression)) {
    const member = expression.properties.find(candidate => propertyName(candidate.name) === name);
    if (member && ts.isPropertyAssignment(member)) return { value: member.initializer, auditable: true };
    if (member && ts.isShorthandPropertyAssignment(member)) return {
      value: member.name,
      auditable: true,
      symbol: checker.getShorthandAssignmentValueSymbol(member),
    };
    return undefined;
  }
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol || seen.has(symbol)) return undefined;
    seen.add(symbol);
    const variable = symbol.declarations?.find(ts.isVariableDeclaration);
    if (!variable?.initializer || !ts.isVariableDeclarationList(variable.parent)) return undefined;
    const value = objectMemberValue(variable.initializer, name, checker, seen);
    return value && (variable.parent.flags & ts.NodeFlags.Const) === 0
      ? { ...value, auditable: false }
      : value;
  }
  const parentName = memberName(expression);
  const parentReceiver = memberReceiver(expression);
  if (!parentName || !parentReceiver) return undefined;
  const parent = objectMemberValue(parentReceiver, parentName, checker, seen);
  if (!parent) return undefined;
  const value = objectMemberValue(parent.value, name, checker, seen);
  return value && !parent.auditable ? { ...value, auditable: false } : value;
}

export function bindingSource(binding: ts.BindingElement): {
  defaults: Array<{ expression: ts.Expression; path: BindingPathSegment[] }>;
  initializer: ts.Expression;
  immutable: boolean;
  path: BindingPathSegment[];
} | undefined {
  const defaults: Array<{ expression: ts.Expression; path: BindingPathSegment[] }> = [];
  const path: BindingPathSegment[] = [];
  let current = binding;
  while (ts.isObjectBindingPattern(current.parent) || ts.isArrayBindingPattern(current.parent)) {
    const segment = ts.isObjectBindingPattern(current.parent)
      ? propertyName(current.propertyName ?? (ts.isIdentifier(current.name) ? current.name : undefined))
      : current.parent.elements.indexOf(current);
    if (segment === undefined || (typeof segment === 'number' && segment < 0)) return undefined;
    path.unshift(segment);
    if (current.initializer) defaults.push({ expression: current.initializer, path: path.slice(1) });
    const owner = current.parent.parent;
    if (ts.isBindingElement(owner)) {
      current = owner;
      continue;
    }
    if (!ts.isVariableDeclaration(owner) || !owner.initializer
      || !ts.isVariableDeclarationList(owner.parent)) return undefined;
    return {
      defaults,
      initializer: owner.initializer,
      immutable: (owner.parent.flags & ts.NodeFlags.Const) !== 0,
      path,
    };
  }
  return undefined;
}

export function bindingDefaultValues(
  source: ReturnType<typeof bindingSource> & {},
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): Array<{ value: ts.Expression; auditable: boolean; symbol?: ts.Symbol }> {
  return source.defaults.flatMap(fallback => {
    if (fallback.path.length === 0) return [{ value: fallback.expression, auditable: false }];
    const value = aggregateValueAtPath(fallback.expression, fallback.path, checker, new Set(seen));
    return value ? [{ ...value, auditable: false }] : [];
  });
}

export function aggregateValueAtPath(
  expression: ts.Expression,
  path: readonly BindingPathSegment[],
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): { value: ts.Expression; auditable: boolean; symbol?: ts.Symbol } | undefined {
  let current: { value: ts.Expression; auditable: boolean; symbol?: ts.Symbol } = {
    value: expression,
    auditable: true,
  };
  for (const segment of path) {
    const member = aggregateMemberValue(current.value, segment, checker, seen);
    if (!member) return undefined;
    current = !current.auditable ? { ...member, auditable: false } : member;
  }
  return current;
}

function aggregateMemberValue(
  expression: ts.Expression,
  segment: BindingPathSegment,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): { value: ts.Expression; auditable: boolean; symbol?: ts.Symbol } | undefined {
  if (typeof segment === 'string') return objectMemberValue(expression, segment, checker, seen);
  expression = unwrap(expression);
  if (ts.isArrayLiteralExpression(expression)) {
    const element = expression.elements[segment];
    return element && !ts.isOmittedExpression(element) && !ts.isSpreadElement(element)
      ? { value: element, auditable: true }
      : undefined;
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  if (!variable?.initializer || !ts.isVariableDeclarationList(variable.parent)) return undefined;
  const value = aggregateMemberValue(variable.initializer, segment, checker, seen);
  return value && (variable.parent.flags & ts.NodeFlags.Const) === 0
    ? { ...value, auditable: false }
    : value;
}
