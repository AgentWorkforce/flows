import ts from 'typescript';
import {
  assignedValues,
  bindingDefaultValues,
  bindingSource,
} from './shipped-source-binding-provenance.js';
import {
  aggregateExpressionValue,
  aggregateExpressionValues,
  aggregateValueAtPath,
  staticArrayElements,
  staticCallArguments,
  staticMemberSegment,
  wrappedExpressionBranches,
} from './shipped-source-binding-values.js';
import { reflectApplyArgumentCandidates } from './shipped-source-reflect-apply.js';

interface FlowCallable {
  args: readonly ts.Expression[];
  auditable: boolean;
}

interface FlowInvocationHelper extends FlowCallable {
  operation: 'call' | 'apply';
}

interface FlowBindInvoker extends FlowInvocationHelper {
  prebound: readonly ts.Expression[];
}

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


function namespaceSymbolAuditable(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): boolean | undefined {
  if (seen.has(symbol)) return undefined;
  if (symbol.declarations?.some(ts.isNamespaceImport)) return true;
  seen.add(symbol);
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding?.initializer) {
    const fallback = namespaceAuditable(binding.initializer, checker, new Set(seen));
    if (fallback !== undefined) return false;
  }
  if (binding) {
    const source = bindingSource(binding, checker);
    if (source) {
      const values = [
        aggregateValueAtPath(source.initializer, source.path, checker, seen),
        ...bindingDefaultValues(source, checker, seen),
      ].filter((value): value is NonNullable<typeof value> => value !== undefined);
      for (const member of values) {
        const nested = member.symbol
          ? namespaceSymbolAuditable(member.symbol, checker, new Set(seen))
          : namespaceAuditable(member.value, checker, new Set(seen));
        if (nested !== undefined) return false;
      }
    }
  }
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  if (!variable?.initializer || !ts.isVariableDeclarationList(variable.parent)) return undefined;
  const nested = namespaceAuditable(variable.initializer, checker, seen);
  return nested === undefined ? undefined : nested && (variable.parent.flags & ts.NodeFlags.Const) !== 0;
}

function namespaceAuditable(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean | undefined {
  expression = unwrap(expression);
  const branches = wrappedExpressionBranches(expression);
  if (branches) {
    return branches.some(branch => namespaceAuditable(branch, checker, new Set(seen)) !== undefined)
      ? false
      : undefined;
  }
  if (!ts.isIdentifier(expression)) {
    const member = aggregateExpressionValue(expression, checker, seen);
    const nested = member?.symbol
      ? namespaceSymbolAuditable(member.symbol, checker, seen)
      : member ? namespaceAuditable(member.value, checker, seen) : undefined;
    return nested === undefined ? undefined : false;
  }
  const symbol = checker.getSymbolAtLocation(expression);
  return symbol ? namespaceSymbolAuditable(symbol, checker, seen) : undefined;
}

function invocationHelper(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): FlowInvocationHelper | undefined {
  expression = unwrap(expression);
  const operation = memberName(expression, checker, new Set(seen));
  const receiver = memberReceiver(expression);
  if ((operation === 'call' || operation === 'apply') && receiver) {
    const constructor = flowConstructor(receiver, checker, new Set(seen));
    if (constructor) return { operation, ...constructor };
    const nested = invocationHelper(receiver, checker, new Set(seen));
    if (nested) return { operation, args: [], auditable: false };
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
  seen.add(symbol);
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding?.initializer) {
    const helper = invocationHelper(binding.initializer, checker, new Set(seen));
    if (helper) return { ...helper, args: [], auditable: false };
  }
  if (binding) {
    for (const value of bindingValues(binding, checker, seen)) {
      const helper = invocationHelper(value.value, checker, new Set(seen));
      if (helper) return { ...helper, args: [], auditable: false };
    }
  }
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  if (!variable?.initializer || !ts.isVariableDeclarationList(variable.parent)) return undefined;
  const helper = invocationHelper(variable.initializer, checker, seen);
  return helper && (variable.parent.flags & ts.NodeFlags.Const) === 0
    ? { ...helper, args: [], auditable: false }
    : helper;
}

function bindHelper(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): FlowCallable | undefined {
  expression = unwrap(expression);
  if (memberName(expression, checker, new Set(seen)) === 'bind') {
    const receiver = memberReceiver(expression);
    const constructor = receiver ? flowConstructor(receiver, checker, new Set(seen)) : undefined;
    if (constructor) return constructor;
  }
  const wrapped = wrappedResult(expression, seen,
    (branch, branchSeen) => bindHelper(branch, checker, branchSeen));
  if (wrapped) return { args: [], auditable: false };
  const aggregate = aggregateResult(expression, checker, seen,
    (value, memberSeen) => bindHelper(value, checker, memberSeen));
  if (aggregate) return aggregate;
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding?.initializer) {
    const helper = bindHelper(binding.initializer, checker, new Set(seen));
    if (helper) return { args: [], auditable: false };
  }
  if (binding) {
    for (const value of bindingValues(binding, checker, seen)) {
      const helper = bindHelper(value.value, checker, new Set(seen));
      if (helper) return { args: [], auditable: false };
    }
  }
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  if (!variable?.initializer || !ts.isVariableDeclarationList(variable.parent)) return undefined;
  const helper = bindHelper(variable.initializer, checker, seen);
  return helper && (variable.parent.flags & ts.NodeFlags.Const) === 0
    ? { args: [], auditable: false }
    : helper;
}

function bindInvoker(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): FlowBindInvoker | undefined {
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
      args: helper.args,
      prebound: expression.arguments.slice(1),
      auditable: helper.auditable && target?.auditable === true
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
  seen.add(symbol);
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding?.initializer) {
    const invoker = bindInvoker(binding.initializer, checker, new Set(seen));
    if (invoker) return { ...invoker, args: [], prebound: [], auditable: false };
  }
  if (binding) {
    for (const value of bindingValues(binding, checker, seen)) {
      const invoker = bindInvoker(value.value, checker, new Set(seen));
      if (invoker) return { ...invoker, args: [], prebound: [], auditable: false };
    }
  }
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  if (!variable?.initializer || !ts.isVariableDeclarationList(variable.parent)) return undefined;
  const invoker = bindInvoker(variable.initializer, checker, seen);
  return invoker && (variable.parent.flags & ts.NodeFlags.Const) === 0
    ? { ...invoker, args: [], prebound: [], auditable: false }
    : invoker;
}

function flowConstructor(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): FlowCallable | undefined {
  expression = unwrap(expression);
  if (memberName(expression, checker, new Set(seen)) === 'flow') {
    const receiver = memberReceiver(expression);
    const auditable = receiver ? namespaceAuditable(receiver, checker) : undefined;
    if (auditable !== undefined) return { args: [], auditable };
  }
  if (ts.isCallExpression(expression)
    && memberName(expression.expression, checker, new Set(seen)) === 'bind') {
    const receiver = memberReceiver(expression.expression);
    const constructor = receiver ? flowConstructor(receiver, checker, new Set(seen)) : undefined;
    const bound = expression.arguments.slice(1);
    if (!constructor && receiver) {
      const helper = invocationHelper(receiver, checker, new Set(seen));
      if (!helper) return undefined;
      if (helper.operation !== 'call' || bound.length < 1) return { args: [], auditable: false };
      return {
        args: [...helper.args, ...bound.slice(1)],
        auditable: helper.auditable && !expression.arguments.some(ts.isSpreadElement),
      };
    }
    if (!constructor) return undefined;
    return {
      args: [...constructor.args, ...bound],
      auditable: constructor.auditable && !expression.arguments.some(ts.isSpreadElement),
    };
  }
  if (ts.isCallExpression(expression)) {
    const invoker = bindInvoker(expression.expression, checker, new Set(seen));
    if (invoker) {
      const args = [...invoker.prebound, ...expression.arguments];
      const target = args[0] ? flowConstructor(args[0], checker, new Set(seen)) : undefined;
      if (invoker.operation !== 'call' || args.length < 2 || !target) {
        return { args: [], auditable: false };
      }
      return {
        args: [...target.args, ...args.slice(2)],
        auditable: invoker.auditable && target.auditable && !expression.arguments.some(ts.isSpreadElement),
      };
    }
    const operation = memberName(expression.expression, checker, new Set(seen));
    const receiver = memberReceiver(expression.expression);
    const helper = receiver ? bindHelper(receiver, checker, new Set(seen)) : undefined;
    if (helper) {
      const target = expression.arguments[0]
        ? flowConstructor(expression.arguments[0], checker, new Set(seen))
        : undefined;
      if (operation !== 'call' || expression.arguments.length < 2 || !target) {
        return { args: [], auditable: false };
      }
      return {
        args: [...target.args, ...expression.arguments.slice(2)],
        auditable: helper.auditable && target.auditable && !expression.arguments.some(ts.isSpreadElement),
      };
    }
  }
  const wrapped = wrappedResult(expression, seen,
    (branch, branchSeen) => flowConstructor(branch, checker, branchSeen));
  if (wrapped) return wrapped;
  const aggregate = aggregateResult(expression, checker, seen,
    (value, memberSeen) => flowConstructor(value, checker, memberSeen));
  if (aggregate) return aggregate;
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  if (expression.text === 'flow'
    && symbol.declarations?.some(declaration => ts.isFunctionDeclaration(declaration))) {
    return { args: [], auditable: true };
  }
  const imported = symbol.declarations?.find(ts.isImportSpecifier);
  if (imported && (imported.propertyName ?? imported.name).text === 'flow') return { args: [], auditable: true };
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding?.initializer) {
    const fallback = flowConstructor(binding.initializer, checker, new Set(seen));
    if (fallback) return { ...fallback, auditable: false };
  }
  if (binding) {
    const source = bindingSource(binding, checker);
    if (source) {
      const direct = aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen));
      const constructor = direct ? flowConstructor(direct.value, checker, new Set(seen)) : undefined;
      if (constructor) return { ...constructor, auditable: false };
      for (const fallback of bindingDefaultValues(source, checker, new Set(seen))) {
        const fallbackConstructor = flowConstructor(fallback.value, checker, new Set(seen));
        if (fallbackConstructor) return { ...fallbackConstructor, auditable: false };
      }
      for (const fallback of source.defaults) {
        if (fallback.path.at(-1) !== 'flow') continue;
        const receiverPath = fallback.path.slice(0, -1);
        const receiver = receiverPath.length === 0
          ? { value: fallback.expression, auditable: false }
          : aggregateValueAtPath(fallback.expression, receiverPath, checker, new Set(seen));
        const namespace = receiver?.symbol
          ? namespaceSymbolAuditable(receiver.symbol, checker, new Set(seen))
          : receiver ? namespaceAuditable(receiver.value, checker) : undefined;
        if (namespace !== undefined) return { args: [], auditable: false };
      }
    }
    if (source?.path.at(-1) === 'flow') {
      for (const fallback of bindingDefaultValues(source, checker, new Set(seen))) {
        const constructor = flowConstructor(fallback.value, checker, new Set(seen));
        if (constructor) return { ...constructor, auditable: false };
      }
      const receiverPath = source.path.slice(0, -1);
      const receiver = receiverPath.length === 0
        ? { value: source.initializer, auditable: true }
        : aggregateValueAtPath(source.initializer, receiverPath, checker, new Set());
      const namespace = receiver?.symbol
        ? namespaceSymbolAuditable(receiver.symbol, checker, new Set())
        : receiver ? namespaceAuditable(receiver.value, checker) : undefined;
      if (namespace !== undefined) return {
        args: [],
        auditable: source.immutable && receiverPath.length === 0 && namespace,
      };
    }
  }
  for (const value of assignedValues(symbol, checker)) {
    const constructor = flowConstructor(value, checker, new Set([...seen, symbol]));
    if (constructor) return { args: [], auditable: false };
  }
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  if (!variable?.initializer || !ts.isVariableDeclarationList(variable.parent)) return undefined;
  const constructor = flowConstructor(variable.initializer, checker, seen);
  return constructor && (variable.parent.flags & ts.NodeFlags.Const) === 0
    ? { args: [], auditable: false }
    : constructor;
}

export function flowInvocation(
  node: ts.Node,
  checker: ts.TypeChecker,
): FlowCallable | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  for (const reflectArgs of reflectApplyArgumentCandidates(node, checker)) {
    const target = reflectArgs[0] ? flowConstructor(reflectArgs[0], checker) : undefined;
    const applied = reflectArgs[2];
    const appliedArgs = applied ? staticArrayElements(applied, checker, new Set()) : undefined;
    if (target) return appliedArgs
      ? {
          args: [...target.args, ...appliedArgs.values.filter((value): value is ts.Expression => value !== undefined)],
          auditable: false,
        }
      : { args: [], auditable: false };
  }
  const constructor = flowConstructor(node.expression, checker);
  if (constructor) return {
    args: [...constructor.args, ...node.arguments],
    auditable: constructor.auditable && !node.arguments.some(ts.isSpreadElement),
  };
  const helper = invocationHelper(node.expression, checker);
  if (!helper) {
    const declaration = checker.getResolvedSignature(node)?.declaration;
    if (declaration && ts.isFunctionLike(declaration) && 'body' in declaration && declaration.body) {
      const forwardedArgs = staticCallArguments(node.arguments, checker)?.values ?? node.arguments;
      for (const argument of forwardedArgs) {
        const forwarded = flowConstructor(ts.isSpreadElement(argument) ? argument.expression : argument, checker);
        if (forwarded) return { args: [], auditable: false };
      }
    }
    return undefined;
  }
  if (helper.operation === 'call') return {
    args: [...helper.args, ...node.arguments.slice(1)],
    auditable: helper.auditable && !node.arguments.some(ts.isSpreadElement),
  };
  const applied = node.arguments[1];
  return applied && ts.isArrayLiteralExpression(applied)
    ? {
        args: [...helper.args, ...applied.elements],
        auditable: helper.auditable && !node.arguments.some(ts.isSpreadElement)
          && !applied.elements.some(ts.isSpreadElement),
      }
    : { args: [], auditable: false };
}

export function flowHeader(args: readonly ts.Expression[], checker: ts.TypeChecker): ts.Expression | undefined {
  if (args.length < 2) return undefined;
  const candidate = args[1];
  if (candidate === undefined) return undefined;
  return args.length === 2 && checker.getTypeAtLocation(candidate).getCallSignatures().length > 0
    ? undefined
    : candidate;
}
