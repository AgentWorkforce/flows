import ts from 'typescript';
import {
  assignedSources,
  bindingSource,
  type BindingPathSegment,
} from './shipped-source-binding-provenance.js';
import { returnedExpressions } from './shipped-source-return-values.js';

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

function propertyName(
  name: ts.PropertyName | undefined,
  checker?: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  if (!ts.isComputedPropertyName(name)) return undefined;
  if (ts.isStringLiteralLike(name.expression)) return name.expression.text;
  const segment = checker
    ? staticPropertySegment(name.expression, checker, new Set(seen))
    : undefined;
  return segment === undefined ? undefined : String(segment);
}

function canonicalArrayIndex(segment: BindingPathSegment): number | undefined {
  if (typeof segment === 'number') return Number.isInteger(segment) && segment >= 0 ? segment : undefined;
  return /^(?:0|[1-9]\d*)$/u.test(segment) ? Number(segment) : undefined;
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
    const source = bindingSource(binding, checker, new Set(seen));
    const values = source?.immutable ? [
      ...(binding.initializer ? [{ value: binding.initializer }] : []),
      ...aggregateValuesAtPath(source.initializer, source.path, checker, new Set(seen))
        .map(value => ({ value })),
      ...bindingDefaultValues(source, checker, new Set(seen)),
    ].filter((value): value is { value: ts.Expression } => value !== undefined)
      .map(value => staticPropertySegment(value.value, checker, new Set(seen)))
      .filter((value): value is BindingPathSegment => value !== undefined) : [];
    if (values.length > 0 && values.every(value => value === values[0])) return values[0];
  }
  const preceding = assignedSources(symbol, checker)
    .filter(source => !source.rest && source.initializer.getStart() < expression.getStart());
  const assigned = preceding
    .flatMap(source => source.path.length === 0
      ? [{ value: source.initializer }]
      : aggregateValuesAtPath(source.initializer, source.path, checker, new Set(seen))
        .map(value => ({ value })))
    .map(value => staticPropertySegment(value.value, checker, new Set(seen)))
    .filter((value): value is BindingPathSegment => value !== undefined);
  if (assigned.length > 0 && assigned.every(value => value === assigned[0])) return assigned[0];
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
): {
  value: ts.Expression;
  auditable: boolean;
  symbol?: ts.Symbol;
  alternatives?: ts.Expression[];
} | undefined {
  expression = unwrap(expression);
  const branches = wrappedExpressionBranches(expression);
  if (branches) {
    const values = [];
    for (const branch of branches) {
      const value = objectMemberValue(branch, name, checker, new Set(seen));
      if (value) values.push(value);
    }
    const [value, ...alternatives] = values;
    return value ? {
      ...value,
      auditable: false,
      alternatives: [
        ...(value.alternatives ?? []),
        ...alternatives.flatMap(candidate => [candidate.value, ...(candidate.alternatives ?? [])]),
      ],
    } : undefined;
  }
  if (ts.isObjectLiteralExpression(expression)) {
    let obscured = false;
    let setterSeen = false;
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
      if (key === undefined || String(key) !== name) continue;
      if (ts.isSetAccessorDeclaration(member)) {
        setterSeen = true;
        continue;
      }
      if (ts.isPropertyAssignment(member)) return setterSeen
        ? undefined
        : { value: member.initializer, auditable: !obscured };
      if (ts.isShorthandPropertyAssignment(member)) return setterSeen
        ? undefined
        : {
            value: member.name,
            auditable: !obscured,
            symbol: checker.getShorthandAssignmentValueSymbol(member),
          };
      if (ts.isGetAccessorDeclaration(member)) {
        const [returned, ...alternatives] = returnedExpressions(member.body);
        return returned ? { value: returned, auditable: false, alternatives } : undefined;
      }
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
      const source = bindingSource(binding, checker);
      if (source?.immutable) {
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
      }
    }
    const variable = symbol.declarations?.find(ts.isVariableDeclaration);
    const variableList = variable && ts.isVariableDeclarationList(variable.parent)
      ? variable.parent
      : undefined;
    if (variable?.initializer && variableList && (variableList.flags & ts.NodeFlags.Const) !== 0) {
      const value = objectMemberValue(variable.initializer, name, checker, seen);
      if (value) return value;
    }
    for (const source of [...assignedSources(symbol, checker)].reverse()) {
      if (source.rest?.kind === 'object' && source.rest.excluded.includes(name)) continue;
      const candidate = source.path.length === 0
        ? { value: source.initializer, auditable: false }
        : aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen));
      if (!candidate) continue;
      if (source.rest?.kind === 'array') {
        const index = canonicalArrayIndex(name);
        const values = staticArrayElements(candidate.value, checker, new Set(seen))?.values;
        const value = index === undefined ? undefined : values?.[source.rest.start + index];
        if (value) return { value, auditable: false };
        continue;
      }
      const value = objectMemberValue(candidate.value, name, checker, new Set(seen));
      if (value) return { ...value, auditable: false };
    }
    if (variable?.initializer && variableList) {
      const value = objectMemberValue(variable.initializer, name, checker, seen);
      if (value) return { ...value, auditable: false };
    }
    return undefined;
  }
  const parent = aggregateExpressionValue(expression, checker, seen);
  if (!parent) return undefined;
  const value = objectMemberValue(parent.value, name, checker, seen);
  return value && !parent.auditable ? { ...value, auditable: false } : value;
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

function aggregateValuesAtPath(
  expression: ts.Expression,
  path: readonly BindingPathSegment[],
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ts.Expression[] {
  let values = [expression];
  for (const segment of path) {
    values = values.flatMap(value => {
      const member = aggregateMemberValue(value, segment, checker, new Set(seen));
      return member ? [member.value, ...(member.alternatives ?? [])] : [];
    });
  }
  return values;
}

export function aggregateExpressionValue(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): {
  value: ts.Expression;
  auditable: boolean;
  symbol?: ts.Symbol;
  alternatives?: ts.Expression[];
} | undefined {
  const segment = staticMemberSegment(expression, checker, seen);
  const receiver = memberReceiver(expression);
  return segment !== undefined && receiver
    ? aggregateMemberValue(receiver, segment, checker, seen)
    : undefined;
}

export function aggregateMemberValue(
  expression: ts.Expression,
  segment: BindingPathSegment,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): {
  value: ts.Expression;
  auditable: boolean;
  symbol?: ts.Symbol;
  alternatives?: ts.Expression[];
} | undefined {
  const stringKey = String(segment);
  if (typeof segment === 'string') {
    const objectSeen = new Set(seen);
    const object = objectMemberValue(expression, stringKey, checker, objectSeen);
    if (object) {
      objectSeen.forEach(symbol => seen.add(symbol));
      return object;
    }
  }
  const index = canonicalArrayIndex(segment);
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

export function bindingDefaultValues(
  source: ReturnType<typeof bindingSource> & {},
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): Array<{ value: ts.Expression; auditable: boolean; applyRest: boolean; symbol?: ts.Symbol }> {
  return source.defaults.flatMap(fallback => {
    if (fallback.path.length === 0) return [{
      value: fallback.expression,
      auditable: false,
      applyRest: fallback.applyRest,
    }];
    const value = aggregateValueAtPath(fallback.expression, fallback.path, checker, new Set(seen));
    return value ? [{ ...value, auditable: false, applyRest: fallback.applyRest }] : [];
  });
}

export function assignedValues(symbol: ts.Symbol, checker: ts.TypeChecker): ts.Expression[] {
  return assignedSources(symbol, checker).flatMap(source => {
    if (source.rest) return [];
    if (source.path.length === 0) return [source.initializer];
    const value = aggregateValueAtPath(source.initializer, source.path, checker, new Set());
    return value ? [value.value] : [];
  });
}

export function staticArrayElements(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): {
  values: Array<ts.Expression | undefined>;
  auditable: boolean;
  alternatives?: Array<Array<ts.Expression | undefined>>;
} | undefined {
  expression = unwrap(expression);
  const branches = wrappedExpressionBranches(expression);
  if (branches) {
    const candidates = [];
    for (const branch of branches) {
      const value = staticArrayElements(branch, checker, new Set(seen));
      if (value) candidates.push(value);
    }
    const [value, ...alternatives] = candidates;
    return value ? {
      ...value,
      auditable: false,
      alternatives: [
        ...(value.alternatives ?? []),
        ...alternatives.flatMap(candidate => [candidate.values, ...(candidate.alternatives ?? [])]),
      ],
    } : undefined;
  }
  if (ts.isArrayLiteralExpression(expression)) {
    let candidates: Array<Array<ts.Expression | undefined>> = [[]];
    let auditable = true;
    for (const element of expression.elements) {
      if (ts.isOmittedExpression(element)) {
        candidates.forEach(values => values.push(undefined));
        continue;
      }
      if (!ts.isSpreadElement(element)) {
        candidates.forEach(values => values.push(element));
        continue;
      }
      const spread = staticArrayElements(element.expression, checker, new Set(seen));
      if (!spread) {
        auditable = false;
        continue;
      }
      const spreadCandidates = [spread.values, ...(spread.alternatives ?? [])];
      candidates = candidates.flatMap(prefix => spreadCandidates.map(values => [...prefix, ...values]));
      auditable &&= spread.auditable && spreadCandidates.length === 1;
    }
    const values = candidates[0] ?? [];
    const alternatives = candidates.slice(1);
    return {
      values,
      auditable,
      ...(alternatives.length > 0 ? { alternatives } : {}),
    };
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
    const source = bindingSource(binding, checker);
    if (source?.immutable) {
      const values = [
        { candidate: aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen)), applyRest: true },
        ...bindingDefaultValues(source, checker, new Set(seen))
          .map(candidate => ({ candidate, applyRest: candidate.applyRest })),
        ...(binding.initializer
          ? [{ candidate: { value: binding.initializer, auditable: false }, applyRest: false }]
          : []),
      ];
      for (const { candidate, applyRest } of values) {
        if (!candidate) continue;
        const value = staticArrayElements(candidate.value, checker, new Set(seen));
        if (value) return {
          auditable: false,
          values: applyRest && source.rest?.kind === 'array'
            ? value.values.slice(source.rest.start)
            : value.values,
        };
      }
    }
  }
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  const variableList = variable && ts.isVariableDeclarationList(variable.parent)
    ? variable.parent
    : undefined;
  if (variable?.initializer && variableList && (variableList.flags & ts.NodeFlags.Const) !== 0) {
    const value = staticArrayElements(variable.initializer, checker, seen);
    if (value) return value;
  }
  for (const source of [...assignedSources(symbol, checker)].reverse()) {
    const candidate = source.path.length === 0
      ? { value: source.initializer, auditable: false }
      : aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen));
    if (!candidate || source.rest?.kind === 'object') continue;
    const value = staticArrayElements(candidate.value, checker, new Set(seen));
    if (value) return {
      auditable: false,
      values: source.rest?.kind === 'array'
        ? value.values.slice(source.rest.start)
        : value.values,
    };
  }
  if (variable?.initializer && variableList) {
    const value = staticArrayElements(variable.initializer, checker, seen);
    if (value) return { ...value, auditable: false };
  }
  return undefined;
}
