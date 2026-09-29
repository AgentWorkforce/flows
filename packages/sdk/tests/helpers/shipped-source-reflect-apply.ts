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

function reflectApplyCallable(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): ReflectApplyCallable | undefined {
  expression = unwrap(expression);
  if (referencesGlobalMember(expression, 'Reflect', 'apply', checker, new Set(seen))) {
    return { operations: [] };
  }
  const branches = wrappedExpressionBranches(expression);
  if (branches) {
    for (const branch of branches) {
      const callable = reflectApplyCallable(branch, checker, new Set(seen));
      if (callable) return callable;
    }
    return undefined;
  }
  const aggregateSeen = new Set(seen);
  for (const aggregate of aggregateExpressionValues(expression, checker, aggregateSeen)) {
    const callable = reflectApplyCallable(aggregate.value, checker, new Set(aggregateSeen));
    if (callable) return callable;
  }
  const operation = staticMemberSegment(expression, checker, new Set(seen));
  const receiver = memberReceiver(expression);
  if (receiver && (operation === 'call' || operation === 'apply')) {
    const callable = reflectApplyCallable(receiver, checker, new Set(seen));
    if (callable) return {
      ...callable,
      operations: [...callable.operations, { kind: operation }],
    };
  }
  if (ts.isCallExpression(expression)) {
    const callOperation = staticMemberSegment(expression.expression, checker, new Set(seen));
    const callReceiver = memberReceiver(expression.expression);
    if (callOperation === 'bind' && callReceiver) {
      const callable = reflectApplyCallable(callReceiver, checker, new Set(seen));
      const args = staticCallArguments(expression.arguments, checker);
      if (callable && args) return {
        ...callable,
        operations: [
          ...callable.operations,
          { kind: 'bind', args: args.values.slice(1) },
        ],
      };
    }
    return undefined;
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding) {
    const source = bindingSource(binding, checker);
    const values = source ? [
      aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen)),
      ...bindingDefaultValues(source, checker, new Set(seen)),
    ].filter((value): value is NonNullable<typeof value> => value !== undefined) : [];
    for (const value of values) {
      const callable = reflectApplyCallable(value.value, checker, new Set(seen));
      if (callable) return callable;
    }
  }
  for (const value of assignedValues(symbol, checker)) {
    const callable = reflectApplyCallable(value, checker, new Set(seen));
    if (callable) return callable;
  }
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  return variable?.initializer
    ? reflectApplyCallable(variable.initializer, checker, seen)
    : undefined;
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

export function reflectApplyArguments(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): readonly ts.Expression[] | undefined {
  const expanded = staticCallArguments(node.arguments, checker);
  if (!expanded) return undefined;
  const callable = reflectApplyCallable(node.expression, checker);
  return callable ? invokeReflectApplyCallable(callable, expanded.values, checker) : undefined;
}
