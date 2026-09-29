import ts from 'typescript';
import { bindingSource } from './shipped-source-binding-provenance.js';
import { aggregateExpressionValues } from './shipped-source-aggregate-values.js';
import {
  aggregateValueAtPath,
  bindingDefaultValues,
  staticMemberSegment,
  wrappedExpressionBranches,
} from './shipped-source-binding-values.js';

export interface FlowCallable {
  args: readonly ts.Expression[];
  auditable: boolean;
}

export interface FlowInvocationHelper extends FlowCallable {
  operation: 'call' | 'apply';
}

export interface FlowBindInvoker extends FlowInvocationHelper {
  prebound: readonly ts.Expression[];
}

type ConstructorResolver = (
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen?: Set<ts.Symbol>,
) => FlowCallable | undefined;

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

function memberName(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): string | undefined {
  const segment = staticMemberSegment(expression, checker, seen);
  return typeof segment === 'string' ? segment : undefined;
}

function memberReceiver(expression: ts.Expression): ts.Expression | undefined {
  expression = unwrap(expression);
  return ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
    ? expression.expression
    : undefined;
}

function bindingValues(
  binding: ts.BindingElement,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): Array<{ value: ts.Expression }> {
  const source = bindingSource(binding, checker);
  if (!source) return [];
  return [
    aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen)),
    ...bindingDefaultValues(source, checker, new Set(seen)),
  ].filter((value): value is NonNullable<typeof value> => value !== undefined);
}

function wrappedResult<T extends { auditable: boolean }>(
  expression: ts.Expression,
  seen: Set<ts.Symbol>,
  resolve: (branch: ts.Expression, seen: Set<ts.Symbol>) => T | undefined,
): T | undefined {
  const branches = wrappedExpressionBranches(expression);
  if (!branches) return undefined;
  for (const branch of branches) {
    const result = resolve(branch, new Set(seen));
    if (result) return { ...result, auditable: false };
  }
  return undefined;
}

function aggregateResult<T extends { auditable: boolean }>(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
  resolve: (value: ts.Expression, seen: Set<ts.Symbol>) => T | undefined,
): T | undefined {
  const memberSeen = new Set(seen);
  for (const member of aggregateExpressionValues(expression, checker, memberSeen)) {
    const result = resolve(member.value, new Set(memberSeen));
    if (result) return { ...result, auditable: false };
  }
  return undefined;
}

export function resolveFlowInvocationHelper(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  resolveConstructor: ConstructorResolver,
  seen = new Set<ts.Symbol>(),
): FlowInvocationHelper | undefined {
  expression = unwrap(expression);
  const operation = memberName(expression, checker, new Set(seen));
  const receiver = memberReceiver(expression);
  if ((operation === 'call' || operation === 'apply') && receiver) {
    const constructor = resolveConstructor(receiver, checker, new Set(seen));
    if (constructor) return { operation, ...constructor };
    const nested = resolveFlowInvocationHelper(receiver, checker, resolveConstructor, new Set(seen));
    if (nested) return { operation, args: [], auditable: false };
  }
  const wrapped = wrappedResult(expression, seen,
    (branch, branchSeen) => resolveFlowInvocationHelper(
      branch,
      checker,
      resolveConstructor,
      branchSeen,
    ));
  if (wrapped) return wrapped;
  const aggregate = aggregateResult(expression, checker, seen,
    (value, memberSeen) => resolveFlowInvocationHelper(
      value,
      checker,
      resolveConstructor,
      memberSeen,
    ));
  if (aggregate) return aggregate;
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding?.initializer) {
    const helper = resolveFlowInvocationHelper(
      binding.initializer,
      checker,
      resolveConstructor,
      new Set(seen),
    );
    if (helper) return { ...helper, args: [], auditable: false };
  }
  if (binding) {
    for (const value of bindingValues(binding, checker, seen)) {
      const helper = resolveFlowInvocationHelper(
        value.value,
        checker,
        resolveConstructor,
        new Set(seen),
      );
      if (helper) return { ...helper, args: [], auditable: false };
    }
  }
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  if (!variable?.initializer || !ts.isVariableDeclarationList(variable.parent)) return undefined;
  const helper = resolveFlowInvocationHelper(variable.initializer, checker, resolveConstructor, seen);
  return helper && (variable.parent.flags & ts.NodeFlags.Const) === 0
    ? { ...helper, args: [], auditable: false }
    : helper;
}

export function resolveFlowBindHelper(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  resolveConstructor: ConstructorResolver,
  seen = new Set<ts.Symbol>(),
): FlowCallable | undefined {
  expression = unwrap(expression);
  if (memberName(expression, checker, new Set(seen)) === 'bind') {
    const receiver = memberReceiver(expression);
    const constructor = receiver ? resolveConstructor(receiver, checker, new Set(seen)) : undefined;
    if (constructor) return constructor;
  }
  const wrapped = wrappedResult(expression, seen,
    (branch, branchSeen) => resolveFlowBindHelper(branch, checker, resolveConstructor, branchSeen));
  if (wrapped) return { args: [], auditable: false };
  const aggregate = aggregateResult(expression, checker, seen,
    (value, memberSeen) => resolveFlowBindHelper(value, checker, resolveConstructor, memberSeen));
  if (aggregate) return aggregate;
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding?.initializer) {
    const helper = resolveFlowBindHelper(
      binding.initializer,
      checker,
      resolveConstructor,
      new Set(seen),
    );
    if (helper) return { args: [], auditable: false };
  }
  if (binding) {
    for (const value of bindingValues(binding, checker, seen)) {
      const helper = resolveFlowBindHelper(value.value, checker, resolveConstructor, new Set(seen));
      if (helper) return { args: [], auditable: false };
    }
  }
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  if (!variable?.initializer || !ts.isVariableDeclarationList(variable.parent)) return undefined;
  const helper = resolveFlowBindHelper(variable.initializer, checker, resolveConstructor, seen);
  return helper && (variable.parent.flags & ts.NodeFlags.Const) === 0
    ? { args: [], auditable: false }
    : helper;
}

export function resolveFlowBindInvoker(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  resolveConstructor: ConstructorResolver,
  seen = new Set<ts.Symbol>(),
): FlowBindInvoker | undefined {
  expression = unwrap(expression);
  if (ts.isCallExpression(expression)
    && memberName(expression.expression, checker, new Set(seen)) === 'bind') {
    const receiver = memberReceiver(expression.expression);
    const operation = receiver ? memberName(receiver, checker, new Set(seen)) : undefined;
    const helperReceiver = receiver ? memberReceiver(receiver) : undefined;
    const helper = helperReceiver
      ? resolveFlowBindHelper(helperReceiver, checker, resolveConstructor, new Set(seen))
      : undefined;
    const target = expression.arguments[0]
      ? resolveFlowBindHelper(expression.arguments[0], checker, resolveConstructor, new Set(seen))
      : undefined;
    if (helper && (operation === 'call' || operation === 'apply')) return {
      operation,
      args: helper.args,
      prebound: expression.arguments.slice(1),
      auditable: helper.auditable && target?.auditable === true
        && !expression.arguments.some(ts.isSpreadElement),
    };
  }
  const wrapped = wrappedResult(expression, seen,
    (branch, branchSeen) => resolveFlowBindInvoker(
      branch,
      checker,
      resolveConstructor,
      branchSeen,
    ));
  if (wrapped) return { ...wrapped, args: [], prebound: [], auditable: false };
  const aggregate = aggregateResult(expression, checker, seen,
    (value, memberSeen) => resolveFlowBindInvoker(
      value,
      checker,
      resolveConstructor,
      memberSeen,
    ));
  if (aggregate) return aggregate;
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding?.initializer) {
    const invoker = resolveFlowBindInvoker(
      binding.initializer,
      checker,
      resolveConstructor,
      new Set(seen),
    );
    if (invoker) return { ...invoker, args: [], prebound: [], auditable: false };
  }
  if (binding) {
    for (const value of bindingValues(binding, checker, seen)) {
      const invoker = resolveFlowBindInvoker(
        value.value,
        checker,
        resolveConstructor,
        new Set(seen),
      );
      if (invoker) return { ...invoker, args: [], prebound: [], auditable: false };
    }
  }
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  if (!variable?.initializer || !ts.isVariableDeclarationList(variable.parent)) return undefined;
  const invoker = resolveFlowBindInvoker(variable.initializer, checker, resolveConstructor, seen);
  return invoker && (variable.parent.flags & ts.NodeFlags.Const) === 0
    ? { ...invoker, args: [], prebound: [], auditable: false }
    : invoker;
}
