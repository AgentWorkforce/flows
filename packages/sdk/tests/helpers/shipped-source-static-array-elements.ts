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

type AggregateValue = {
  value: ts.Expression;
  auditable: boolean;
  symbol?: ts.Symbol;
  alternatives?: ts.Expression[];
};

type BindingDefaultValue = AggregateValue & { applyRest: boolean };

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
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding) {
    const source = bindingSource(binding, checker);
    if (source?.immutable) {
      const values = [
        { candidate: resolvers.aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen)), applyRest: true },
        ...resolvers.bindingDefaultValues(source, checker, new Set(seen))
          .map(candidate => ({ candidate, applyRest: candidate.applyRest })),
        ...(binding.initializer
          ? [{ candidate: { value: binding.initializer, auditable: false }, applyRest: false }]
          : []),
      ];
      for (const { candidate, applyRest } of values) {
        if (!candidate) continue;
        const value = resolveStaticArrayElements(candidate.value, checker, new Set(seen), resolvers);
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
    const value = resolveStaticArrayElements(variable.initializer, checker, seen, resolvers);
    if (value) return value;
  }
  for (const source of [...assignedSources(symbol, checker)].reverse()) {
    const candidate = source.path.length === 0
      ? { value: source.initializer, auditable: false }
      : resolvers.aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen));
    if (!candidate || source.rest?.kind === 'object') continue;
    const value = resolveStaticArrayElements(candidate.value, checker, new Set(seen), resolvers);
    if (value) return {
      auditable: false,
      values: source.rest?.kind === 'array'
        ? value.values.slice(source.rest.start)
        : value.values,
    };
  }
  if (variable?.initializer && variableList) {
    const value = resolveStaticArrayElements(variable.initializer, checker, seen, resolvers);
    if (value) return { ...value, auditable: false };
  }
  return undefined;
}
