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
import { referencesGlobalMember } from './shipped-source-global-provenance.js';

interface ReflectApplyCallable {
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

function reflectApplyCallables(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): ReflectApplyCallable[] {
  expression = unwrap(expression);
  const callables: ReflectApplyCallable[] = [];
  if (referencesGlobalMember(expression, 'Reflect', 'apply', checker, new Set(seen))) {
    callables.push({ operations: [] });
  }
  const branches = wrappedExpressionBranches(expression);
  if (branches) {
    for (const branch of branches) {
      callables.push(...reflectApplyCallables(branch, checker, new Set(seen)));
    }
    return callables;
  }
  const aggregateSeen = new Set(seen);
  for (const aggregate of aggregateExpressionValues(expression, checker, aggregateSeen)) {
    callables.push(...reflectApplyCallables(aggregate.value, checker, new Set(aggregateSeen)));
  }
  const operation = staticMemberSegment(expression, checker, new Set(seen));
  const receiver = memberReceiver(expression);
  if (receiver && (operation === 'call' || operation === 'apply')) {
    for (const callable of reflectApplyCallables(receiver, checker, new Set(seen))) callables.push({
      ...callable,
      operations: [...callable.operations, { kind: operation }],
    });
    return callables;
  }
  if (ts.isCallExpression(expression)) {
    const callOperation = staticMemberSegment(expression.expression, checker, new Set(seen));
    const callReceiver = memberReceiver(expression.expression);
    if (callOperation === 'bind' && callReceiver) {
      const args = staticCallArguments(expression.arguments, checker);
      if (args) {
        for (const callable of reflectApplyCallables(callReceiver, checker, new Set(seen))) {
          callables.push({
            ...callable,
            operations: [
              ...callable.operations,
              { kind: 'bind', args: args.values.slice(1) },
            ],
          });
        }
      }
    }
    return callables;
  }
  if (!ts.isIdentifier(expression)) return callables;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return callables;
  seen.add(symbol);
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding) {
    const source = bindingSource(binding, checker);
    const values = source ? [
      aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen)),
      ...bindingDefaultValues(source, checker, new Set(seen)),
    ].filter((value): value is NonNullable<typeof value> => value !== undefined) : [];
    for (const value of values) {
      callables.push(...reflectApplyCallables(value.value, checker, new Set(seen)));
    }
  }
  for (const value of assignedValues(symbol, checker)) {
    callables.push(...reflectApplyCallables(value, checker, new Set(seen)));
  }
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  if (variable?.initializer) {
    callables.push(...reflectApplyCallables(variable.initializer, checker, seen));
  }
  return callables;
}

function invokeReflectApplyCallable(
  callable: ReflectApplyCallable,
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

export function reflectApplyArgumentCandidates(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): Array<readonly ts.Expression[]> {
  const expanded = staticCallArguments(node.arguments, checker);
  if (!expanded) return [];
  return reflectApplyCallables(node.expression, checker).flatMap(callable => {
    const invoked = invokeReflectApplyCallable(callable, expanded.values, checker);
    return invoked ? [invoked] : [];
  });
}
