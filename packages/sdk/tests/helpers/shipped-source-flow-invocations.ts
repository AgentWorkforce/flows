import ts from 'typescript';

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

function propertyName(name: ts.PropertyName | undefined): string | undefined {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
  return ts.isComputedPropertyName(name) && ts.isStringLiteralLike(name.expression)
    ? name.expression.text
    : undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

function memberName(expression: ts.Expression): string | undefined {
  expression = unwrap(expression);
  if (ts.isPropertyAccessExpression(expression)) return expression.name.text;
  if (ts.isElementAccessExpression(expression) && expression.argumentExpression
    && ts.isStringLiteralLike(expression.argumentExpression)) return expression.argumentExpression.text;
  return undefined;
}

function memberReceiver(expression: ts.Expression): ts.Expression | undefined {
  expression = unwrap(expression);
  return ts.isPropertyAccessExpression(expression) || ts.isElementAccessExpression(expression)
    ? expression.expression
    : undefined;
}

function namespaceAuditable(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean | undefined {
  expression = unwrap(expression);
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  if (symbol.declarations?.some(ts.isNamespaceImport)) return true;
  seen.add(symbol);
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  if (!variable?.initializer || !ts.isVariableDeclarationList(variable.parent)) return undefined;
  const nested = namespaceAuditable(variable.initializer, checker, seen);
  return nested === undefined ? undefined : nested && (variable.parent.flags & ts.NodeFlags.Const) !== 0;
}

function invocationHelper(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): FlowInvocationHelper | undefined {
  expression = unwrap(expression);
  const operation = memberName(expression);
  const receiver = memberReceiver(expression);
  if ((operation === 'call' || operation === 'apply') && receiver) {
    const constructor = flowConstructor(receiver, checker, seen);
    if (constructor) return { operation, ...constructor };
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
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
  if (memberName(expression) === 'bind') {
    const receiver = memberReceiver(expression);
    return receiver ? flowConstructor(receiver, checker, new Set(seen)) : undefined;
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
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
  if (ts.isCallExpression(expression) && memberName(expression.expression) === 'bind') {
    const receiver = memberReceiver(expression.expression);
    const operation = receiver ? memberName(receiver) : undefined;
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
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
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
  if (memberName(expression) === 'flow') {
    const receiver = memberReceiver(expression);
    const auditable = receiver ? namespaceAuditable(receiver, checker) : undefined;
    if (auditable !== undefined) return { args: [], auditable };
  }
  if (ts.isCallExpression(expression) && memberName(expression.expression) === 'bind') {
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
    const operation = memberName(expression.expression);
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
  if (binding && ts.isObjectBindingPattern(binding.parent)) {
    const name = binding.propertyName ?? (ts.isIdentifier(binding.name) ? binding.name : undefined);
    const declaration = binding.parent.parent;
    if (propertyName(name) === 'flow' && ts.isVariableDeclaration(declaration) && declaration.initializer) {
      const namespace = namespaceAuditable(declaration.initializer, checker);
      if (namespace !== undefined && ts.isVariableDeclarationList(declaration.parent)) {
        return {
          args: [],
          auditable: namespace && (declaration.parent.flags & ts.NodeFlags.Const) !== 0,
        };
      }
    }
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
  const constructor = flowConstructor(node.expression, checker);
  if (constructor) return {
    args: [...constructor.args, ...node.arguments],
    auditable: constructor.auditable && !node.arguments.some(ts.isSpreadElement),
  };
  const helper = invocationHelper(node.expression, checker);
  if (!helper) return undefined;
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
