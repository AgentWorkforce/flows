import ts from 'typescript';
import {
  assignedSourceMayPrecedeReference,
  assignedSources,
  bindingSource,
  type BindingPathSegment,
  type BindingRest,
} from './shipped-source-binding-provenance.js';
import {
  canonicalArrayIndex,
  unwrapExpression as unwrap,
  wrappedExpressionBranches,
} from './shipped-source-expression-values.js';
import { returnedExpressions } from './shipped-source-return-values.js';
import {
  resolveStaticArrayElements,
  type StaticArrayElementsResult,
} from './shipped-source-static-array-elements.js';

export { wrappedExpressionBranches } from './shipped-source-expression-values.js';

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

export function staticPropertySegment(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): BindingPathSegment | undefined {
  expression = unwrap(expression);
  if (ts.isIdentifier(expression)
    && ((ts.isPropertyAssignment(expression.parent) && expression.parent.name === expression)
      || (ts.isShorthandPropertyAssignment(expression.parent) && expression.parent.name === expression)
      || (ts.isMethodDeclaration(expression.parent) && expression.parent.name === expression)
      || (ts.isGetAccessorDeclaration(expression.parent) && expression.parent.name === expression)
      || (ts.isSetAccessorDeclaration(expression.parent) && expression.parent.name === expression))) {
    return expression.text;
  }
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
  const bindingCandidates: Array<BindingPathSegment | undefined> = [];
  if (binding) {
    const source = bindingSource(binding, checker, new Set(seen));
    const pathValues = source
      ? aggregateValuesAtPath(source.initializer, source.path, checker, new Set(seen))
      : [];
    const initialValues = source ? [
      ...(binding.initializer ? [{ value: binding.initializer }] : []),
      ...pathValues.map(value => ({ value })),
      ...bindingDefaultValues(source, checker, new Set(seen)),
    ].filter((value): value is { value: ts.Expression } => value !== undefined)
      .map(value => staticPropertySegment(value.value, checker, new Set(seen)))
      .concat(pathValues.length === 0 ? [undefined] : []) : [];
    if (source?.immutable) {
      const first = initialValues[0];
      if (first !== undefined
        && initialValues.every(value => value !== undefined && value === first)) return first;
    } else if (source) {
      bindingCandidates.push(...(initialValues.length > 0 ? initialValues : [undefined]));
    }
  }
  const preceding = assignedSources(symbol, checker)
    .filter(source => !source.rest
      && assignedSourceMayPrecedeReference(source, symbol, expression));
  const declaration = symbol.declarations?.find(ts.isVariableDeclaration);
  const candidates = [
    ...bindingCandidates,
    ...(declaration?.initializer && declaration.initializer.getStart() < expression.getStart()
      ? [staticPropertySegment(declaration.initializer, checker, new Set(seen))]
      : []),
    ...preceding.flatMap(source => {
      const values = source.path.length === 0
        ? [source.initializer]
        : aggregateValuesAtPath(source.initializer, source.path, checker, new Set(seen));
      return values.length > 0
        ? values.map(value => staticPropertySegment(value, checker, new Set(seen)))
        : [undefined];
    }),
  ];
  const first = candidates[0];
  return first !== undefined
    && candidates.every(value => value !== undefined && value === first)
    ? first
    : undefined;
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
    const candidates: Array<{
      auditable: boolean;
      rest?: BindingRest;
      value: ts.Expression;
    }> = [];
    const binding = symbol.declarations?.find(ts.isBindingElement);
    if (binding) {
      const source = bindingSource(binding, checker);
      if (source) {
        if (source.rest?.kind === 'object' && source.rest.excluded.includes(name)) return undefined;
        candidates.push(
          ...aggregateValuesAtPath(source.initializer, source.path, checker, new Set(seen))
            .map(value => ({ value, auditable: false, rest: source.rest })),
          ...bindingDefaultValues(source, checker, new Set(seen))
            .map(value => ({
              value: value.value,
              auditable: false,
              ...(value.applyRest ? { rest: source.rest } : {}),
            })),
          ...(binding.initializer ? [{ value: binding.initializer, auditable: false }] : []),
        );
      }
    }
    const variable = symbol.declarations?.find(ts.isVariableDeclaration);
    const variableList = variable && ts.isVariableDeclarationList(variable.parent)
      ? variable.parent
      : undefined;
    if (variable?.initializer && variableList && (variableList.flags & ts.NodeFlags.Const) !== 0) {
      candidates.push({ value: variable.initializer, auditable: true });
    }
    for (const source of assignedSources(symbol, checker)
      .filter(candidate => assignedSourceMayPrecedeReference(candidate, symbol, expression))) {
      if (source.rest?.kind === 'object' && source.rest.excluded.includes(name)) continue;
      const values = source.path.length === 0
        ? [source.initializer]
        : aggregateValuesAtPath(source.initializer, source.path, checker, new Set(seen));
      candidates.push(...values.map(value => ({ value, auditable: false, rest: source.rest })));
    }
    if (variable?.initializer && variableList && (variableList.flags & ts.NodeFlags.Const) === 0) {
      candidates.push({ value: variable.initializer, auditable: false });
    }
    const values: Array<{
      value: ts.Expression;
      auditable: boolean;
      symbol?: ts.Symbol;
      alternatives?: ts.Expression[];
    }> = [];
    for (const candidate of candidates) {
      if (candidate.rest?.kind === 'array') {
        const index = canonicalArrayIndex(name);
        const start = candidate.rest.start;
        const array = staticArrayElements(candidate.value, checker, new Set(seen));
        if (index !== undefined && array) {
          for (const elements of [array.values, ...(array.alternatives ?? [])]) {
            const value = elements[start + index];
            if (value) values.push({ value, auditable: false });
          }
        }
        continue;
      }
      const value = objectMemberValue(candidate.value, name, checker, new Set(seen));
      if (value) values.push({ ...value, auditable: candidate.auditable && value.auditable });
    }
    const [value, ...alternatives] = values;
    return value ? {
      ...value,
      auditable: candidates.length === 1 && alternatives.length === 0 && value.auditable,
      alternatives: [
        ...(value.alternatives ?? []),
        ...alternatives.flatMap(candidate => [candidate.value, ...(candidate.alternatives ?? [])]),
      ],
    } : undefined;
  }
  const parent = aggregateExpressionValue(expression, checker, seen);
  if (!parent) return undefined;
  const values = [parent.value, ...(parent.alternatives ?? [])].flatMap(candidate => {
    const value = objectMemberValue(candidate, name, checker, new Set(seen));
    return value ? [value] : [];
  });
  const [value, ...alternatives] = values;
  return value ? {
    ...value,
    auditable: parent.auditable && alternatives.length === 0 ? value.auditable : false,
    alternatives: [
      ...(value.alternatives ?? []),
      ...alternatives.flatMap(candidate => [candidate.value, ...(candidate.alternatives ?? [])]),
    ],
  } : undefined;
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

export function aggregateValuesAtPath(
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
    const candidates = array ? [array.values, ...(array.alternatives ?? [])]
      .flatMap(values => values[index] ? [values[index]] : []) : [];
    const [value, ...alternatives] = candidates;
    if (value) {
      arraySeen.forEach(symbol => seen.add(symbol));
      return {
        value,
        auditable: array!.auditable && alternatives.length === 0,
        ...(alternatives.length > 0 ? { alternatives } : {}),
      };
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
    return aggregateValuesAtPath(source.initializer, source.path, checker, new Set());
  });
}

export function staticArrayElements(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): StaticArrayElementsResult | undefined {
  return resolveStaticArrayElements(expression, checker, seen, {
    aggregateExpressionValue,
    aggregateValueAtPath,
    bindingDefaultValues,
  });
}
