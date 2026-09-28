import ts from 'typescript';

type WorkerMethod = 'agent' | 'llm';

interface WorkerCallable {
  method: WorkerMethod;
  args: readonly ts.Expression[];
  auditable: boolean;
}

interface WorkerInvocationHelper extends WorkerCallable {
  operation: 'call' | 'apply';
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

function immutableInitializer(
  expression: ts.Identifier,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): ts.Expression | undefined {
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  seen.add(symbol);
  const variable = symbol.declarations?.find(ts.isVariableDeclaration);
  return variable?.initializer && ts.isVariableDeclarationList(variable.parent)
    && (variable.parent.flags & ts.NodeFlags.Const) !== 0
    ? variable.initializer
    : undefined;
}

function invocationHelper(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): WorkerInvocationHelper | undefined {
  expression = unwrap(expression);
  const operation = memberName(expression);
  const receiver = memberReceiver(expression);
  if ((operation === 'call' || operation === 'apply') && receiver) {
    const callable = workerCallable(receiver, checker, new Set(seen));
    if (callable) return { operation, ...callable };
  }
  if (!ts.isIdentifier(expression)) return undefined;
  const initializer = immutableInitializer(expression, checker, seen);
  return initializer ? invocationHelper(initializer, checker, seen) : undefined;
}

function workerCallable(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): WorkerCallable | undefined {
  expression = unwrap(expression);
  const direct = memberName(expression);
  if (direct === 'agent' || direct === 'llm') return { method: direct, args: [], auditable: true };
  if (ts.isCallExpression(expression) && memberName(expression.expression) === 'bind') {
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
  if (!ts.isIdentifier(expression)) return undefined;
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return undefined;
  const binding = symbol.declarations?.find(ts.isBindingElement);
  if (binding && ts.isObjectBindingPattern(binding.parent)) {
    const name = propertyName(binding.propertyName ?? (ts.isIdentifier(binding.name) ? binding.name : undefined));
    return name === 'agent' || name === 'llm' ? { method: name, args: [], auditable: true } : undefined;
  }
  const initializer = immutableInitializer(expression, checker, seen);
  return initializer ? workerCallable(initializer, checker, seen) : undefined;
}

export function workerMethodName(expression: ts.Expression, checker: ts.TypeChecker): string | undefined {
  return workerCallable(expression, checker)?.method;
}

export function workerInvocation(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
): WorkerInvocation | undefined {
  const callable = workerCallable(node.expression, checker);
  if (callable) return {
    method: callable.method,
    args: [...callable.args, ...node.arguments],
    auditable: callable.auditable && !node.arguments.some(ts.isSpreadElement),
  };
  const helper = invocationHelper(node.expression, checker);
  if (!helper) return undefined;
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
