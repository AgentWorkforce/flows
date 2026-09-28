import ts from 'typescript';

export type BindingPathSegment = string | number;

type BindingRest =
  | { excluded: string[]; kind: 'object' }
  | { kind: 'array'; start: number };

export function wrappedExpressionBranches(expression: ts.Expression): readonly ts.Expression[] | undefined {
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

export function staticPropertySegment(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): BindingPathSegment | undefined {
  expression = unwrap(expression);
  if (ts.isStringLiteralLike(expression)) return expression.text;
  if (ts.isNumericLiteral(expression)) return Number(expression.text);
  const type = checker.getTypeAtLocation(expression);
  if (type.isStringLiteral()) return type.value;
  if ((type.flags & ts.TypeFlags.NumberLiteral) !== 0) return (type as ts.NumberLiteralType).value;
  const branches = wrappedExpressionBranches(expression);
  if (branches) {
    const values = branches.map(branch => staticPropertySegment(branch, checker, new Set(seen)));
    const first = values[0];
    return first !== undefined && values.every(value => value === first) ? first : undefined;
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding) {
    const source = bindingSource(binding);
    const values = source?.immutable ? [
      ...(binding.initializer ? [{ value: binding.initializer }] : []),
      aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen)),
      ...bindingDefaultValues(source, checker, new Set(seen)),
    ].filter((value): value is { value: ts.Expression } => value !== undefined)
      .map(value => staticPropertySegment(value.value, checker, new Set(seen)))
      .filter((value): value is BindingPathSegment => value !== undefined) : [];
    if (values.length > 0 && values.every(value => value === values[0])) return values[0];
  }
  const declaration = symbol.declarations?.find(ts.isVariableDeclaration);
  if (!declaration?.initializer || !ts.isVariableDeclarationList(declaration.parent)
    || (declaration.parent.flags & ts.NodeFlags.Const) === 0) return undefined;
  return staticPropertySegment(declaration.initializer, checker, seen);
}

function memberReceiver(expression: ts.Expression): ts.Expression | undefined {
  expression = unwrap(expression);
  return ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
    ? expression.expression
    : undefined;
}

export function staticMemberSegment(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): BindingPathSegment | undefined {
  expression = unwrap(expression);
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (!ts.isElementAccessExpression(expression) || !expression.argumentExpression) return undefined;
  return staticPropertySegment(expression.argumentExpression, checker, seen);
}

export function objectMemberValue(
  expression: ts.Expression,
  name: string,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): { value: ts.Expression; auditable: boolean; symbol?: ts.Symbol } | undefined {
  expression = unwrap(expression);
  const branches = wrappedExpressionBranches(expression);
  if (branches) {
    for (const branch of branches) {
      const value = objectMemberValue(branch, name, checker, new Set(seen));
      if (value) return { ...value, auditable: false };
    }
    return undefined;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    let obscured = false;
    for (const member of [...expression.properties].reverse()) {
      if (ts.isSpreadAssignment(member)) {
        const value = objectMemberValue(member.expression, name, checker, new Set(seen));
        if (value) return { ...value, auditable: false };
        obscured = true;
        continue;
      }
      const key = propertyName(member.name)
        ?? (member.name && ts.isComputedPropertyName(member.name)
          ? staticPropertySegment(member.name.expression, checker, new Set(seen))
          : undefined);
      if (member.name && ts.isComputedPropertyName(member.name) && key === undefined) {
        obscured = true;
        continue;
      }
      if (key !== name) continue;
      if (ts.isPropertyAssignment(member)) return { value: member.initializer, auditable: !obscured };
      if (ts.isShorthandPropertyAssignment(member)) return {
        value: member.name,
        auditable: !obscured,
        symbol: checker.getShorthandAssignmentValueSymbol(member),
      };
      return undefined;
    }
    return undefined;
  }
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol || seen.has(symbol)) return undefined;
    seen.add(symbol);
    const binding = symbol.declarations?.find(ts.isBindingElement);
    if (binding) {
      const source = bindingSource(binding);
      if (!source?.immutable) return undefined;
      if (source.rest?.kind === 'object' && source.rest.excluded.includes(name)) return undefined;
      const values = [
        aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen)),
        ...bindingDefaultValues(source, checker, new Set(seen)),
        ...(binding.initializer ? [{ value: binding.initializer, auditable: false }] : []),
      ];
      for (const candidate of values) {
        if (!candidate) continue;
        const value = objectMemberValue(candidate.value, name, checker, new Set(seen));
        if (value) return { ...value, auditable: false };
      }
      return undefined;
    }
    const variable = symbol.declarations?.find(ts.isVariableDeclaration);
    if (!variable?.initializer || !ts.isVariableDeclarationList(variable.parent)) return undefined;
    const value = objectMemberValue(variable.initializer, name, checker, seen);
    return value && (variable.parent.flags & ts.NodeFlags.Const) === 0
      ? { ...value, auditable: false }
      : value;
  }
  const parent = aggregateExpressionValue(expression, checker, seen);
  if (!parent) return undefined;
  const value = objectMemberValue(parent.value, name, checker, seen);
  return value && !parent.auditable ? { ...value, auditable: false } : value;
}

export function bindingSource(binding: ts.BindingElement): {
  defaults: Array<{ expression: ts.Expression; path: BindingPathSegment[] }>;
  initializer: ts.Expression;
  immutable: boolean;
  path: BindingPathSegment[];
  rest?: BindingRest;
} | undefined {
  const defaults: Array<{ expression: ts.Expression; path: BindingPathSegment[] }> = [];
  const path: BindingPathSegment[] = [];
  let rest: BindingRest | undefined;
  let current = binding;
  while (ts.isObjectBindingPattern(current.parent) || ts.isArrayBindingPattern(current.parent)) {
    if (current.dotDotDotToken) {
      if (rest) return undefined;
      if (ts.isObjectBindingPattern(current.parent)) {
        rest = {
          excluded: current.parent.elements
            .filter(element => element !== current && !element.dotDotDotToken)
            .map(element => propertyName(
              element.propertyName ?? (ts.isIdentifier(element.name) ? element.name : undefined),
            ))
            .filter((name): name is string => name !== undefined),
          kind: 'object',
        };
      } else {
        const start = current.parent.elements.indexOf(current);
        if (start < 0) return undefined;
        rest = { kind: 'array', start };
      }
    } else {
      const segment = ts.isObjectBindingPattern(current.parent)
        ? propertyName(current.propertyName ?? (ts.isIdentifier(current.name) ? current.name : undefined))
        : current.parent.elements.indexOf(current);
      if (segment === undefined || (typeof segment === 'number' && segment < 0)) return undefined;
      path.unshift(segment);
    }
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
      rest,
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

export function aggregateExpressionValue(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): { value: ts.Expression; auditable: boolean; symbol?: ts.Symbol } | undefined {
  const segment = staticMemberSegment(expression, checker, seen);
  const receiver = memberReceiver(expression);
  return segment !== undefined && receiver
    ? aggregateMemberValue(receiver, segment, checker, seen)
    : undefined;
}

function aggregateMemberValue(
  expression: ts.Expression,
  segment: BindingPathSegment,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): { value: ts.Expression; auditable: boolean; symbol?: ts.Symbol } | undefined {
  const stringKey = String(segment);
  if (typeof segment === 'string') {
    const objectSeen = new Set(seen);
    const object = objectMemberValue(expression, stringKey, checker, objectSeen);
    if (object) {
      objectSeen.forEach(symbol => seen.add(symbol));
      return object;
    }
  }
  const index = typeof segment === 'number'
    ? segment
    : /^(?:0|[1-9]\d*)$/u.test(segment) ? Number(segment) : undefined;
  if (index !== undefined) {
    const arraySeen = new Set(seen);
    const array = staticArrayElements(expression, checker, arraySeen);
    const value = array?.values[index];
    if (value) {
      arraySeen.forEach(symbol => seen.add(symbol));
      return { value, auditable: array.auditable };
    }
  }
  return typeof segment === 'number'
    ? objectMemberValue(expression, stringKey, checker, seen)
    : undefined;
}

function staticArrayElements(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): { values: Array<ts.Expression | undefined>; auditable: boolean } | undefined {
  expression = unwrap(expression);
  const branches = wrappedExpressionBranches(expression);
  if (branches) {
    for (const branch of branches) {
      const value = staticArrayElements(branch, checker, new Set(seen));
      if (value) return { ...value, auditable: false };
    }
    return undefined;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    const values: Array<ts.Expression | undefined> = [];
    let auditable = true;
    for (const element of expression.elements) {
      if (ts.isOmittedExpression(element)) {
        values.push(undefined);
        continue;
      }
      if (!ts.isSpreadElement(element)) {
        values.push(element);
        continue;
      }
      const spread = staticArrayElements(element.expression, checker, new Set(seen));
      if (!spread) return { values, auditable: false };
      values.push(...spread.values);
      auditable &&= spread.auditable;
    }
    return { values, auditable };
  }
  const parentSeen = new Set(seen);
  const parent = aggregateExpressionValue(expression, checker, parentSeen);
  if (parent) {
    const value = staticArrayElements(parent.value, checker, parentSeen);
    return value ? { ...value, auditable: false } : undefined;
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding) {
    const source = bindingSource(binding);
    if (!source?.immutable) return undefined;
    const values = [
      aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen)),
      ...bindingDefaultValues(source, checker, new Set(seen)),
      ...(binding.initializer ? [{ value: binding.initializer, auditable: false }] : []),
    ];
    for (const candidate of values) {
      if (!candidate) continue;
      const value = staticArrayElements(candidate.value, checker, new Set(seen));
      if (value) return {
        auditable: false,
        values: source.rest?.kind === 'array'
          ? value.values.slice(source.rest.start)
          : value.values,
      };
    }
    return undefined;
  }
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  if (!variable?.initializer || !ts.isVariableDeclarationList(variable.parent)) return undefined;
  const value = staticArrayElements(variable.initializer, checker, seen);
  return value && (variable.parent.flags & ts.NodeFlags.Const) === 0
    ? { ...value, auditable: false }
    : value;
}
