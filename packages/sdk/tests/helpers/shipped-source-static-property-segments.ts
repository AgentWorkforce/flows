import ts from 'typescript';
import {
  assignedSources,
  bindingSource,
  type BindingPathSegment,
} from './shipped-source-binding-provenance.js';
import {
  aggregateMemberValue,
  aggregateValueAtPath,
  staticPropertySegment,
  wrappedExpressionBranches,
} from './shipped-source-binding-values.js';
import { returnedExpressions } from './shipped-source-return-values.js';

type MemberValueCandidates = (
  expression: ts.Expression,
  seen: Set<ts.Symbol>,
) => ts.Expression[];

type SeenMemberPaths = Map<ts.Symbol, Set<string>>;

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

function memberRootPaths(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): Array<{ path: BindingPathSegment[]; symbol: ts.Symbol }> {
  expression = unwrap(expression);
  const branches = wrappedExpressionBranches(expression);
  if (branches) return branches.flatMap(branch => memberRootPaths(branch, checker, new Set(seen)));
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    return symbol ? [{ path: [], symbol }] : [];
  }
  if (ts.isCallExpression(expression)) {
    const declaration = checker.getResolvedSignature(expression)?.declaration;
    const symbol = checker.getSymbolAtLocation(unwrap(expression.expression));
    if (!declaration || !ts.isFunctionLike(declaration) || !('body' in declaration)
      || (symbol && seen.has(symbol))) return [];
    const nextSeen = symbol ? new Set(seen).add(symbol) : new Set(seen);
    return returnedExpressions(declaration.body).flatMap(returned =>
      memberRootPaths(returned, checker, new Set(nextSeen)));
  }
  if (!ts.isPropertyAccessExpression(expression) && !ts.isElementAccessExpression(expression)) return [];
  const segment = ts.isPropertyAccessExpression(expression)
    ? expression.name.text
    : expression.argumentExpression
      ? staticPropertySegment(expression.argumentExpression, checker, new Set(seen))
      : undefined;
  return segment === undefined ? [] : memberRootPaths(expression.expression, checker, seen)
    .map(parent => ({ ...parent, path: [...parent.path, segment] }));
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
    values.push(...aggregateValuesAtPath(initializer, path, checker, new Set(nextSeen)));
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

function localCallReturnCandidates(
  expression: ts.CallExpression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): { candidates: ts.Expression[]; seen: Set<ts.Symbol> } | undefined {
  const declaration = checker.getResolvedSignature(expression)?.declaration;
  const symbol = checker.getSymbolAtLocation(unwrap(expression.expression));
  if (!declaration || !ts.isFunctionLike(declaration) || !('body' in declaration)
    || (symbol && seen.has(symbol))) return undefined;
  return {
    candidates: returnedExpressions(declaration.body),
    seen: symbol ? new Set(seen).add(symbol) : new Set(seen),
  };
}

function cloneSeenMemberPaths(seen: SeenMemberPaths): SeenMemberPaths {
  return new Map([...seen].map(([symbol, paths]) => [symbol, new Set(paths)]));
}

function memberPathKey(path: readonly BindingPathSegment[]): string {
  return JSON.stringify(path.map(segment => [typeof segment, segment]));
}

export function staticPropertySegments(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
  memberValueCandidates?: MemberValueCandidates,
  seenMemberPaths: SeenMemberPaths = new Map(),
): BindingPathSegment[] {
  const exact = staticPropertySegment(expression, checker, new Set(seen));
  if (exact !== undefined) return [exact];
  expression = unwrap(expression);
  const branches = wrappedExpressionBranches(expression);
  if (branches) return [...new Set(branches.flatMap(branch =>
    staticPropertySegments(
      branch,
      checker,
      new Set(seen),
      memberValueCandidates,
      cloneSeenMemberPaths(seenMemberPaths),
    )))];
  if (ts.isCallExpression(expression)) {
    const returned = localCallReturnCandidates(expression, checker, seen);
    if (returned) return [...new Set(returned.candidates.flatMap(candidate =>
      staticPropertySegments(
        candidate,
        checker,
        new Set(returned.seen),
        memberValueCandidates,
        cloneSeenMemberPaths(seenMemberPaths),
      )))];
  }
  if (!ts.isIdentifier(expression)) {
    const discoveredMembers = memberRootPaths(expression, checker, seen);
    const members = discoveredMembers.filter(member =>
      !seenMemberPaths.get(member.symbol)?.has(memberPathKey(member.path)));
    if (discoveredMembers.length > 0 && members.length === 0) return [];
    const candidates = [
      ...members.flatMap(member => aggregateMemberCandidates(expression, member, checker, seen)),
      ...(memberValueCandidates?.(expression, new Set(seen)) ?? []),
    ];
    const nextSeenMembers = cloneSeenMemberPaths(seenMemberPaths);
    for (const member of members) {
      const key = memberPathKey(member.path);
      const paths = nextSeenMembers.get(member.symbol) ?? new Set<string>();
      paths.add(key);
      nextSeenMembers.set(member.symbol, paths);
    }
    return [...new Set(candidates.flatMap(candidate =>
      staticPropertySegments(
        candidate,
        checker,
        new Set(seen),
        memberValueCandidates,
        cloneSeenMemberPaths(nextSeenMembers),
      )))];
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
      cloneSeenMemberPaths(seenMemberPaths),
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
