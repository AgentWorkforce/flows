import ts from 'typescript';
import {
  assignedValues,
  bindingDefaultValues,
  bindingSource,
} from './shipped-source-binding-provenance.js';
import {
  aggregateExpressionValues,
  aggregateValueAtPath,
  staticArrayElements,
  staticCallArguments,
  staticMemberSegment,
  wrappedExpressionBranches,
} from './shipped-source-binding-values.js';

type CallableMatcher = (
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
) => boolean;

interface CallableCandidate {
  operations: Array<
    | { kind: 'apply' | 'call' }
    | { kind: 'bind'; args: ts.Expression[] }
  >;
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

function memberReceiver(expression: ts.Expression): ts.Expression | undefined {
  expression = unwrap(expression);
  return ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
    ? expression.expression
    : undefined;
}

function callableCandidates(
  expression: ts.Expression,
  matcher: CallableMatcher,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): CallableCandidate[] {
  expression = unwrap(expression);
  const candidates: CallableCandidate[] = [];
  if (matcher(expression, checker, new Set(seen))) candidates.push({ operations: [] });
  const branches = wrappedExpressionBranches(expression);
  if (branches) {
    for (const branch of branches) {
      candidates.push(...callableCandidates(branch, matcher, checker, new Set(seen)));
    }
    return candidates;
  }
  const aggregateSeen = new Set(seen);
  for (const aggregate of aggregateExpressionValues(expression, checker, aggregateSeen)) {
    candidates.push(...callableCandidates(aggregate.value, matcher, checker, new Set(aggregateSeen)));
  }
  const operation = staticMemberSegment(expression, checker, new Set(seen));
  const receiver = memberReceiver(expression);
  if (receiver && (operation === 'call' || operation === 'apply')) {
    for (const callable of callableCandidates(receiver, matcher, checker, new Set(seen))) {
      candidates.push({
        ...callable,
        operations: [...callable.operations, { kind: operation }],
      });
    }
    return candidates;
  }
  if (ts.isCallExpression(expression)) {
    const callOperation = staticMemberSegment(expression.expression, checker, new Set(seen));
    const callReceiver = memberReceiver(expression.expression);
    if (callOperation === 'bind' && callReceiver) {
      const args = staticCallArguments(expression.arguments, checker);
      if (args) {
        for (const callable of callableCandidates(callReceiver, matcher, checker, new Set(seen))) {
          candidates.push({
            ...callable,
            operations: [
              ...callable.operations,
              { kind: 'bind', args: args.values.slice(1) },
            ],
          });
        }
      }
    }
    return candidates;
  }
  if (!ts.isIdentifier(expression)) return candidates;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return candidates;
  seen.add(symbol);
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding) {
    const source = bindingSource(binding, checker);
    const values = source ? [
      aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen)),
      ...bindingDefaultValues(source, checker, new Set(seen)),
    ].filter((value): value is NonNullable<typeof value> => value !== undefined) : [];
    for (const value of values) {
      candidates.push(...callableCandidates(value.value, matcher, checker, new Set(seen)));
    }
  }
  for (const value of assignedValues(symbol, checker)) {
    candidates.push(...callableCandidates(value, matcher, checker, new Set(seen)));
  }
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  if (variable?.initializer) {
    candidates.push(...callableCandidates(variable.initializer, matcher, checker, seen));
  }
  return candidates;
}

function invokeCallableCandidate(
  callable: CallableCandidate,
  args: readonly ts.Expression[],
  checker: ts.TypeChecker,
): readonly ts.Expression[] | undefined {
  let invoked = [...args];
  for (const operation of [...callable.operations].reverse()) {
    if (operation.kind === 'bind') {
      invoked = [...operation.args, ...invoked];
      continue;
    }
    if (operation.kind === 'call') {
      invoked = invoked.slice(1);
      continue;
    }
    const applied = invoked[1]
      ? staticArrayElements(invoked[1], checker, new Set())?.values
        .filter((value): value is ts.Expression => value !== undefined)
      : undefined;
    if (!applied) return undefined;
    invoked = applied;
  }
  return invoked;
}

export function callableArgumentCandidates(
  expression: ts.Expression,
  args: readonly ts.Expression[],
  matcher: CallableMatcher,
  checker: ts.TypeChecker,
): Array<readonly ts.Expression[]> {
  const expanded = staticCallArguments(args, checker);
  if (!expanded) return [];
  return callableCandidates(expression, matcher, checker).flatMap(callable => {
    const invoked = invokeCallableCandidate(callable, expanded.values, checker);
    return invoked ? [invoked] : [];
  });
}
