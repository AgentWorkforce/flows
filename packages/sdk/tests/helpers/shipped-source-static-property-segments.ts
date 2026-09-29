import ts from 'typescript';
import {
  assignedSources,
  bindingSource,
  type BindingPathSegment,
} from './shipped-source-binding-provenance.js';
import {
  aggregateValueAtPath,
  staticPropertySegment,
  wrappedExpressionBranches,
} from './shipped-source-binding-values.js';

type MemberValueCandidates = (
  expression: ts.Expression,
  seen: Set<ts.Symbol>,
) => ts.Expression[];

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

export function staticPropertySegments(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
  memberValueCandidates?: MemberValueCandidates,
): BindingPathSegment[] {
  const exact = staticPropertySegment(expression, checker, new Set(seen));
  if (exact !== undefined) return [exact];
  expression = unwrap(expression);
  const branches = wrappedExpressionBranches(expression);
  if (branches) return [...new Set(branches.flatMap(branch =>
    staticPropertySegments(branch, checker, new Set(seen), memberValueCandidates)))];
  if (!ts.isIdentifier(expression)) {
    return [...new Set((memberValueCandidates?.(expression, new Set(seen)) ?? []).flatMap(candidate =>
      staticPropertySegments(candidate, checker, new Set(seen), memberValueCandidates)))];
  }
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return [];
  const nextSeen = new Set(seen).add(symbol);
  const values: BindingPathSegment[] = [];
  const add = (candidate: ts.Expression | undefined): void => {
    if (!candidate) return;
    for (const value of staticPropertySegments(
      candidate,
      checker,
      new Set(nextSeen),
      memberValueCandidates,
    )) {
      if (!values.includes(value)) values.push(value);
    }
  };
  for (const source of assignedSources(symbol, checker)) {
    if (source.rest || source.initializer.getStart() >= expression.getStart()) continue;
    const candidate = source.path.length === 0
      ? { value: source.initializer }
      : aggregateValueAtPath(source.initializer, source.path, checker, new Set(nextSeen));
    add(candidate?.value);
  }
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding) {
    const source = bindingSource(binding, checker, new Set(nextSeen));
    if (source?.immutable) add(aggregateValueAtPath(
      source.initializer,
      source.path,
      checker,
      new Set(nextSeen),
    )?.value);
    add(binding.initializer);
  }
  add(symbol.declarations?.find(ts.isVariableDeclaration)?.initializer);
  return values;
}
