import ts from 'typescript';
import {
  aggregateExpressionValue,
  aggregateValueAtPath,
  assignedValues,
  bindingDefaultValues,
  bindingSource,
  referencesGlobalMember,
  staticCallArguments,
  staticArrayElements,
  staticMemberSegment,
  wrappedExpressionBranches,
} from './shipped-source-binding-values.js';
import { symbolHasWrites } from './shipped-source-receiver-writes.js';

type WorkerMethod = 'agent' | 'llm';

interface WorkerCallable {
  method: WorkerMethod;
  args: readonly ts.Expression[];
  auditable: boolean;
}

interface WorkerInvocationHelper extends WorkerCallable {
  operation: 'call' | 'apply';
}

interface WorkerBindInvoker extends WorkerInvocationHelper {
  prebound: readonly ts.Expression[];
}

export interface WorkerInvocation extends WorkerCallable {}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)
    ? name.expression.text
    : undefined;
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

function variableInitializer(
  expression: ts.Identifier,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): { expression: ts.Expression; immutable: boolean } | undefined {
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  if (!variable?.initializer || !ts.isVariableDeclarationList(variable.parent)) return undefined;
  return {
    expression: variable.initializer,
    immutable: (variable.parent.flags & ts.NodeFlags.Const) !== 0,
  };
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
  const member = aggregateExpressionValue(expression, checker, memberSeen);
  const result = member ? resolve(member.value, memberSeen) : undefined;
  return result ? { ...result, auditable: false } : undefined;
}

function invocationHelper(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): WorkerInvocationHelper | undefined {
  expression = unwrap(expression);
  const operation = memberName(expression, checker, new Set(seen));
  const receiver = memberReceiver(expression);
  if ((operation === 'call' || operation === 'apply') && receiver) {
    const callable = workerCallable(receiver, checker, new Set(seen));
    if (callable) return { operation, ...callable };
    const nested = invocationHelper(receiver, checker, new Set(seen));
    if (nested) return { operation, method: nested.method, args: [], auditable: false };
  }
  const wrapped = wrappedResult(expression, seen,
    (branch, branchSeen) => invocationHelper(branch, checker, branchSeen));
  if (wrapped) return wrapped;
  const aggregate = aggregateResult(expression, checker, seen,
    (value, memberSeen) => invocationHelper(value, checker, memberSeen));
  if (aggregate) return aggregate;
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding) {
    seen.add(symbol);
    if (binding.initializer) {
      const helper = invocationHelper(binding.initializer, checker, new Set(seen));
      if (helper) return { ...helper, args: [], auditable: false };
    }
    for (const value of bindingValues(binding, checker, seen)) {
      const helper = invocationHelper(value.value, checker, new Set(seen));
      if (helper) return { ...helper, args: [], auditable: false };
    }
  }
  const initializer = variableInitializer(expression, checker, seen);
  if (!initializer) return undefined;
  const helper = invocationHelper(initializer.expression, checker, seen);
  return helper && !initializer.immutable ? { ...helper, args: [], auditable: false } : helper;
}

function bindHelper(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): WorkerCallable | undefined {
  expression = unwrap(expression);
  if (memberName(expression, checker, new Set(seen)) === 'bind') {
    const receiver = memberReceiver(expression);
    const callable = receiver ? workerCallable(receiver, checker, new Set(seen)) : undefined;
    if (callable) return callable;
  }
  const wrapped = wrappedResult(expression, seen,
    (branch, branchSeen) => bindHelper(branch, checker, branchSeen));
  if (wrapped) return { ...wrapped, args: [], auditable: false };
  const aggregate = aggregateResult(expression, checker, seen,
    (value, memberSeen) => bindHelper(value, checker, memberSeen));
  if (aggregate) return aggregate;
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding) {
    seen.add(symbol);
    if (binding.initializer) {
      const callable = bindHelper(binding.initializer, checker, new Set(seen));
      if (callable) return { ...callable, args: [], auditable: false };
    }
    for (const value of bindingValues(binding, checker, seen)) {
      const callable = bindHelper(value.value, checker, new Set(seen));
      if (callable) return { ...callable, args: [], auditable: false };
    }
  }
  const initializer = variableInitializer(expression, checker, seen);
  if (!initializer) return undefined;
  const callable = bindHelper(initializer.expression, checker, seen);
  return callable && !initializer.immutable ? { ...callable, args: [], auditable: false } : callable;
}

function bindInvoker(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): WorkerBindInvoker | undefined {
  expression = unwrap(expression);
  if (ts.isCallExpression(expression)
    && memberName(expression.expression, checker, new Set(seen)) === 'bind') {
    const receiver = memberReceiver(expression.expression);
    const operation = receiver ? memberName(receiver, checker, new Set(seen)) : undefined;
    const helperReceiver = receiver ? memberReceiver(receiver) : undefined;
    const helper = helperReceiver ? bindHelper(helperReceiver, checker, new Set(seen)) : undefined;
    const target = expression.arguments[0]
      ? bindHelper(expression.arguments[0], checker, new Set(seen))
      : undefined;
    if (helper && (operation === 'call' || operation === 'apply')) return {
      operation,
      method: helper.method,
      args: helper.args,
      prebound: expression.arguments.slice(1),
      auditable: helper.auditable && target?.method === helper.method && target.auditable
        && !expression.arguments.some(ts.isSpreadElement),
    };
  }
  const wrapped = wrappedResult(expression, seen,
    (branch, branchSeen) => bindInvoker(branch, checker, branchSeen));
  if (wrapped) return { ...wrapped, args: [], prebound: [], auditable: false };
  const aggregate = aggregateResult(expression, checker, seen,
    (value, memberSeen) => bindInvoker(value, checker, memberSeen));
  if (aggregate) return aggregate;
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding) {
    seen.add(symbol);
    if (binding.initializer) {
      const invoker = bindInvoker(binding.initializer, checker, new Set(seen));
      if (invoker) return { ...invoker, args: [], prebound: [], auditable: false };
    }
    for (const value of bindingValues(binding, checker, seen)) {
      const invoker = bindInvoker(value.value, checker, new Set(seen));
      if (invoker) return { ...invoker, args: [], prebound: [], auditable: false };
    }
  }
  const initializer = variableInitializer(expression, checker, seen);
  if (!initializer) return undefined;
  const invoker = bindInvoker(initializer.expression, checker, seen);
  return invoker && !initializer.immutable
    ? { ...invoker, args: [], prebound: [], auditable: false }
    : invoker;
}

function receiverAuditable(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
  allowOpaqueRoot = true,
): boolean {
  expression = unwrap(expression);
  if (!ts.isIdentifier(expression)) {
    const receiver = memberReceiver(expression);
    return receiver ? receiverAuditable(receiver, checker, seen, false) : false;
  }
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return false;
  seen.add(symbol);
  if (symbolHasWrites(symbol, checker)) return false;
  if (symbol.declarations?.some(ts.isBindingElement)) return false;
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  if (!variable) return allowOpaqueRoot;
  if (!ts.isVariableDeclarationList(variable.parent)
    || (variable.parent.flags & ts.NodeFlags.Const) === 0) return false;
  if (!variable.initializer) return allowOpaqueRoot;
  return receiverAuditable(variable.initializer, checker, seen, allowOpaqueRoot);
}

function workerCallable(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): WorkerCallable | undefined {
  expression = unwrap(expression);
  const direct = memberName(expression, checker, new Set(seen));
  if (direct === 'agent' || direct === 'llm') {
    const receiver = memberReceiver(expression);
    return { method: direct, args: [], auditable: receiver ? receiverAuditable(receiver, checker) : false };
  }
  if (ts.isCallExpression(expression)
    && memberName(expression.expression, checker, new Set(seen)) === 'bind') {
    const receiver = memberReceiver(expression.expression);
    const callable = receiver ? workerCallable(receiver, checker, new Set(seen)) : undefined;
    const bound = expression.arguments.slice(1);
    if (callable) return {
      method: callable.method,
      args: [...callable.args, ...bound],
      auditable: callable.auditable && !expression.arguments.some(ts.isSpreadElement),
    };
    const helper = receiver ? invocationHelper(receiver, checker, new Set(seen)) : undefined;
    if (!helper) return undefined;
    if (helper.operation !== 'call' || bound.length < 1) {
      return { method: helper.method, args: [], auditable: false };
    }
    return {
      method: helper.method,
      args: [...helper.args, ...bound.slice(1)],
      auditable: helper.auditable && !expression.arguments.some(ts.isSpreadElement),
    };
  }
  if (ts.isCallExpression(expression)) {
    const invoker = bindInvoker(expression.expression, checker, new Set(seen));
    if (invoker) {
      const args = [...invoker.prebound, ...expression.arguments];
      const target = args[0] ? workerCallable(args[0], checker, new Set(seen)) : undefined;
      if (invoker.operation !== 'call' || args.length < 2 || target?.method !== invoker.method) {
        return { method: invoker.method, args: [], auditable: false };
      }
      return {
        method: invoker.method,
        args: [...target.args, ...args.slice(2)],
        auditable: invoker.auditable && target.auditable && !expression.arguments.some(ts.isSpreadElement),
      };
    }
    const operation = memberName(expression.expression, checker, new Set(seen));
    const receiver = memberReceiver(expression.expression);
    const helper = receiver ? bindHelper(receiver, checker, new Set(seen)) : undefined;
    if (helper) {
      const target = expression.arguments[0]
        ? workerCallable(expression.arguments[0], checker, new Set(seen))
        : undefined;
      if (operation !== 'call' || expression.arguments.length < 2
        || target?.method !== helper.method) return { method: helper.method, args: [], auditable: false };
      return {
        method: helper.method,
        args: [...target.args, ...expression.arguments.slice(2)],
        auditable: helper.auditable && target.auditable && !expression.arguments.some(ts.isSpreadElement),
      };
    }
  }
  const wrapped = wrappedResult(expression, seen,
    (branch, branchSeen) => workerCallable(branch, checker, branchSeen));
  if (wrapped) return wrapped;
  const aggregate = aggregateResult(expression, checker, seen,
    (value, memberSeen) => workerCallable(value, checker, memberSeen));
  if (aggregate) return aggregate;
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding) seen.add(symbol);
  if (binding?.initializer) {
    const callable = workerCallable(binding.initializer, checker, new Set(seen));
    if (callable) return { ...callable, args: [], auditable: false };
  }
  if (binding) {
    for (const value of bindingValues(binding, checker, seen)) {
      const callable = workerCallable(value.value, checker, new Set(seen));
      if (callable) return { ...callable, args: [], auditable: false };
    }
  }
  for (const value of assignedValues(symbol, checker)) {
    const callable = workerCallable(value, checker, new Set([...seen, symbol]));
    if (callable) return { ...callable, args: [], auditable: false };
  }
  if (binding && ts.isObjectBindingPattern(binding.parent)) {
    const name = propertyName(binding.propertyName ?? (ts.isIdentifier(binding.name) ? binding.name : undefined));
    const declaration = binding.parent.parent;
    const immutable = ts.isVariableDeclaration(declaration)
      && ts.isVariableDeclarationList(declaration.parent)
      && (declaration.parent.flags & ts.NodeFlags.Const) !== 0;
    const receiver = ts.isVariableDeclaration(declaration) ? declaration.initializer : undefined;
    return name === 'agent' || name === 'llm'
      ? { method: name, args: [], auditable: immutable && !!receiver && receiverAuditable(receiver, checker) }
      : undefined;
  }
  const initializer = variableInitializer(expression, checker, seen);
  if (!initializer) return undefined;
  const callable = workerCallable(initializer.expression, checker, seen);
  return callable && !initializer.immutable ? { ...callable, args: [], auditable: false } : callable;
}

function reflectApplyArguments(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): readonly ts.Expression[] | undefined {
  const direct = referencesGlobalMember(node.expression, 'Reflect', 'apply', checker);
  const expanded = staticCallArguments(node.arguments, checker);
  if (direct) return expanded?.values;
  const receiver = memberReceiver(node.expression);
  if (!receiver || !referencesGlobalMember(receiver, 'Reflect', 'apply', checker)) return undefined;
  const operation = memberName(node.expression, checker);
  if (operation === 'call') return expanded?.values.slice(1);
  if (operation !== 'apply' || !expanded?.values[1]) return undefined;
  return staticArrayElements(expanded.values[1], checker, new Set())?.values
    .filter((value): value is ts.Expression => value !== undefined);
}

export function workerMethodName(expression: ts.Expression, checker: ts.TypeChecker): string | undefined {
  return workerCallable(expression, checker)?.method;
}

export function workerInvocation(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): WorkerInvocation | undefined {
  const reflectArgs = reflectApplyArguments(node, checker);
  if (reflectArgs) {
    const target = reflectArgs[0] ? workerCallable(reflectArgs[0], checker) : undefined;
    const applied = reflectArgs[2];
    const appliedArgs = applied ? staticArrayElements(applied, checker, new Set()) : undefined;
    if (target) return appliedArgs
      ? {
          method: target.method,
          args: [...target.args, ...appliedArgs.values.filter((value): value is ts.Expression => value !== undefined)],
          auditable: false,
        }
      : { method: target.method, args: [], auditable: false };
  }
  const callable = workerCallable(node.expression, checker);
  if (callable) return {
    method: callable.method,
    args: [...callable.args, ...node.arguments],
    auditable: callable.auditable && !node.arguments.some(ts.isSpreadElement),
  };
  const helper = invocationHelper(node.expression, checker);
  if (!helper) {
    const declaration = checker.getResolvedSignature(node)?.declaration;
    if (declaration && ts.isFunctionLike(declaration) && 'body' in declaration && declaration.body) {
      const forwardedArgs = staticCallArguments(node.arguments, checker)?.values ?? node.arguments;
      for (const argument of forwardedArgs) {
        const forwarded = workerCallable(ts.isSpreadElement(argument) ? argument.expression : argument, checker);
        if (forwarded) return { method: forwarded.method, args: [], auditable: false };
      }
    }
    return undefined;
  }
  if (helper.operation === 'call') return {
    method: helper.method,
    args: [...helper.args, ...node.arguments.slice(1)],
    auditable: helper.auditable && !node.arguments.some(ts.isSpreadElement),
  };
  const applied = node.arguments[1];
  return applied && ts.isArrayLiteralExpression(applied)
    ? {
        method: helper.method,
        args: [...helper.args, ...applied.elements],
        auditable: helper.auditable && !node.arguments.some(ts.isSpreadElement)
          && !applied.elements.some(ts.isSpreadElement),
      }
    : { method: helper.method, args: [], auditable: false };
}
