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

function memberRootPath(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): { path: BindingPathSegment[]; symbol: ts.Symbol } | undefined {
  expression = unwrap(expression);
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    return symbol ? { path: [], symbol } : undefined;
  }
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return undefined;
  const parent = memberRootPath(expression.expression, checker, seen);
  if (!parent) return undefined;
  const segment = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : expression.argumentExpression
      ? staticPropertySegment(expression.argumentExpression, checker, new Set(seen))
      : undefined;
  return segment === undefined ? undefined : { ...parent, path: [...parent.path, segment] };
}

function aggregateMemberCandidates(
  expression: ts.Expression,
  member: { path: BindingPathSegment[]; symbol: ts.Symbol },
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ts.Expression[] {
  const nextSeen = new Set(seen).add(member.symbol);
  const values: ts.Expression[] = [];
  const add = (
    initializer: ts.Expression | undefined,
    path: readonly BindingPathSegment[] = member.path,
  ): void => {
    if (!initializer) return;
    const candidate = aggregateValueAtPath(initializer, path, checker, new Set(nextSeen));
    if (candidate) values.push(candidate.value);
  };
  for (const source of assignedSources(member.symbol, checker)) {
    if (source.rest || source.initializer.getStart() >= expression.getStart()) continue;
    add(source.initializer, [...source.path, ...member.path]);
  }
  const binding = member.symbol.declarations?.find(ts.isBindingElement);
  if (binding) {
    const source = bindingSource(binding, checker, new Set(nextSeen));
    if (source) add(source.initializer, [...source.path, ...member.path]);
    add(binding.initializer);
  }
  add(member.symbol.declarations?.find(ts.isVariableDeclaration)?.initializer);
  return values;
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
    const member = memberRootPath(expression, checker, seen);
    if (member && seen.has(member.symbol)) return [];
    const candidates = [
      ...(member ? aggregateMemberCandidates(expression, member, checker, seen) : []),
      ...(memberValueCandidates?.(expression, new Set(seen)) ?? []),
    ];
    const nextSeen = member ? new Set(seen).add(member.symbol) : new Set(seen);
    return [...new Set(candidates.flatMap(candidate =>
      staticPropertySegments(candidate, checker, new Set(nextSeen), memberValueCandidates)))];
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
