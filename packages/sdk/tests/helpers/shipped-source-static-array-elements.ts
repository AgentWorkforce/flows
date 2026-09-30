import ts from 'typescript';
import {
  assignedSources,
  bindingSource,
  type BindingPathSegment,
} from './shipped-source-binding-provenance.js';
import {
  canonicalArrayIndex,
  unwrapExpression,
  wrappedExpressionBranches,
} from './shipped-source-expression-values.js';
import { returnedExpressions } from './shipped-source-return-values.js';

type AggregateValue = {
  value: ts.Expression;
  auditable: boolean;
  symbol?: ts.Symbol;
  alternatives?: ts.Expression[];
};

type BindingDefaultValue = AggregateValue & { applyRest: boolean };

type ReturnedParameter = {
  parameter: ts.ParameterDeclaration;
  parameterIndex: number;
  path: BindingPathSegment[];
};

interface StaticArrayResolvers {
  aggregateExpressionValue(
    expression: ts.Expression,
    checker: ts.TypeChecker,
    seen: Set<ts.Symbol>,
  ): AggregateValue | undefined;
  aggregateValueAtPath(
    expression: ts.Expression,
    path: readonly BindingPathSegment[],
    checker: ts.TypeChecker,
    seen: Set<ts.Symbol>,
  ): AggregateValue | undefined;
  bindingDefaultValues(
    source: ReturnType<typeof bindingSource> & {},
    checker: ts.TypeChecker,
    seen: Set<ts.Symbol>,
  ): BindingDefaultValue[];
}

export interface StaticArrayElementsResult {
  values: Array<ts.Expression | undefined>;
  auditable: boolean;
  alternatives?: Array<Array<ts.Expression | undefined>>;
}

function returnedParameter(
  expression: ts.Expression,
  declaration: ts.SignatureDeclaration,
  checker: ts.TypeChecker,
): ReturnedParameter | undefined {
  expression = unwrapExpression(expression);
  const path: BindingPathSegment[] = [];
  while (ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)) {
    if (ts.isPropertyAccessExpression(expression)) path.unshift(expression.name.text);
    else {
      const argument = expression.argumentExpression && unwrapExpression(expression.argumentExpression);
      const segment = argument && (ts.isStringLiteralLike(argument) || ts.isNumericLiteral(argument))
        ? argument.text
        : undefined;
      if (segment === undefined) return undefined;
      path.unshift(segment);
    }
    expression = unwrapExpression(expression.expression);
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol) return undefined;
  const parameterIndex = declaration.parameters.findIndex(parameter =>
    ts.isIdentifier(parameter.name) && checker.getSymbolAtLocation(parameter.name) === symbol);
  const parameter = declaration.parameters[parameterIndex];
  return parameter ? { parameter, parameterIndex, path } : undefined;
}

function callArgumentCandidates(
  args: readonly ts.Expression[],
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
  resolvers: StaticArrayResolvers,
): ts.Expression[][] {
  let candidates: ts.Expression[][] = [[]];
  for (const argument of args) {
    if (!ts.isSpreadElement(argument)) {
      candidates.forEach(values => values.push(argument));
      continue;
    }
    const spread = resolveStaticArrayElements(
      argument.expression,
      checker,
      new Set(seen),
      resolvers,
    );
    if (!spread) return [];
    const branches = [spread.values, ...(spread.alternatives ?? [])]
      .filter(values => values.every((value): value is ts.Expression => value !== undefined));
    if (branches.length === 0 || candidates.length * branches.length > 64) return [];
    candidates = candidates.flatMap(prefix => branches.map(values => [...prefix, ...values]));
  }
  return candidates;
}

export function resolveStaticArrayElements(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
  resolvers: StaticArrayResolvers,
): StaticArrayElementsResult | undefined {
  expression = unwrapExpression(expression);
  const branches = wrappedExpressionBranches(expression);
  if (branches) {
    const candidates = branches.flatMap(branch => {
      const value = resolveStaticArrayElements(branch, checker, new Set(seen), resolvers);
      return value ? [value] : [];
    });
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
      const spread = resolveStaticArrayElements(element.expression, checker, new Set(seen), resolvers);
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
    return { values, auditable, ...(alternatives.length > 0 ? { alternatives } : {}) };
  }
  if (ts.isCallExpression(expression)) {
    const declaration = checker.getResolvedSignature(expression)?.declaration;
    if (declaration && ts.isFunctionLike(declaration) && 'body' in declaration) {
      const callee = unwrapExpression(expression.expression);
      const symbol = checker.getSymbolAtLocation(callee)
        ?? (declaration.name ? checker.getSymbolAtLocation(declaration.name) : undefined);
      if (symbol && seen.has(symbol)) return undefined;
      const nextSeen = symbol ? new Set(seen).add(symbol) : new Set(seen);
      const candidates: Array<Array<ts.Expression | undefined>> = [];
      const actualCandidates = callArgumentCandidates(
        expression.arguments,
        checker,
        nextSeen,
        resolvers,
      );
      for (const returned of returnedExpressions(declaration.body)) {
        const branches = wrappedExpressionBranches(unwrapExpression(returned)) ?? [returned];
        for (const branch of branches) {
          const mapped = returnedParameter(branch, declaration, checker);
          if (!mapped) continue;
          for (const actuals of actualCandidates) {
            if (mapped.parameter.dotDotDotToken && mapped.path.length === 0) {
              candidates.push(actuals.slice(mapped.parameterIndex));
              continue;
            }
            const supplied = actuals[mapped.parameterIndex];
            const actual = supplied ?? mapped.parameter.initializer;
            if (!actual || ts.isSpreadElement(actual)) continue;
            const selected = mapped.path.length === 0
              ? { value: actual, auditable: false }
              : resolvers.aggregateValueAtPath(
                  actual,
                  mapped.path,
                  checker,
                  new Set(nextSeen),
                );
            if (!selected) continue;
            for (const value of [selected.value, ...(selected.alternatives ?? [])]) {
              const array = resolveStaticArrayElements(
                value,
                checker,
                new Set(nextSeen),
                resolvers,
              );
              if (array) candidates.push(array.values, ...(array.alternatives ?? []));
            }
          }
        }
        const value = resolveStaticArrayElements(returned, checker, new Set(nextSeen), resolvers);
        if (value) candidates.push(value.values, ...(value.alternatives ?? []));
      }
      const [values, ...alternatives] = candidates;
      if (values) return {
        values,
        auditable: false,
        ...(alternatives.length > 0 ? { alternatives } : {}),
      };
    }
  }
  const parentSeen = new Set(seen);
  const parent = resolvers.aggregateExpressionValue(expression, checker, parentSeen);
  if (parent) {
    const value = resolveStaticArrayElements(parent.value, checker, parentSeen, resolvers);
    return value ? { ...value, auditable: false } : undefined;
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const candidates: Array<Array<ts.Expression | undefined>> = [];
  const addValue = (
    candidate: AggregateValue | undefined,
    restStart?: number,
  ): void => {
    if (!candidate) return;
    for (const expression of [candidate.value, ...(candidate.alternatives ?? [])]) {
      const value = resolveStaticArrayElements(expression, checker, new Set(seen), resolvers);
      if (!value) continue;
      for (const elements of [value.values, ...(value.alternatives ?? [])]) {
        candidates.push(restStart === undefined ? elements : elements.slice(restStart));
      }
    }
  };
  const result = (): StaticArrayElementsResult | undefined => {
    const [values, ...alternatives] = candidates;
    return values ? {
      values,
      auditable: false,
      ...(alternatives.length > 0 ? { alternatives } : {}),
    } : undefined;
  };
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding) {
    const source = bindingSource(binding, checker);
    if (source) {
      const values = [
        { candidate: resolvers.aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen)), applyRest: true },
        ...resolvers.bindingDefaultValues(source, checker, new Set(seen))
          .map(candidate => ({ candidate, applyRest: candidate.applyRest })),
        ...(binding.initializer
          ? [{ candidate: { value: binding.initializer, auditable: false }, applyRest: false }]
          : []),
      ];
      for (const { candidate, applyRest } of values) {
        addValue(
          candidate,
          applyRest && source.rest?.kind === 'array' ? source.rest.start : undefined,
        );
      }
      if (source.immutable) return result();
    }
  }
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  const variableList = variable && ts.isVariableDeclarationList(variable.parent)
    ? variable.parent
    : undefined;
  if (variable?.initializer && variableList && (variableList.flags & ts.NodeFlags.Const) !== 0) {
    const value = resolveStaticArrayElements(variable.initializer, checker, seen, resolvers);
    if (value) return value;
  }
  for (const source of [...assignedSources(symbol, checker)].reverse()) {
    const candidate = source.path.length === 0
      ? { value: source.initializer, auditable: false }
      : resolvers.aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen));
    if (!candidate || source.rest?.kind === 'object') continue;
    addValue(candidate, source.rest?.kind === 'array' ? source.rest.start : undefined);
  }
  if (variable?.initializer && variableList) {
    const value = resolveStaticArrayElements(variable.initializer, checker, seen, resolvers);
    if (value) candidates.push(value.values, ...(value.alternatives ?? []));
  }
  return result();
}
