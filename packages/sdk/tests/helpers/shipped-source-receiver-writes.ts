import ts from 'typescript';
import {
  aggregateExpressionValue,
  aggregateValueAtPath,
  bindingDefaultValues,
  bindingSource,
  wrappedExpressionBranches,
} from './shipped-source-binding-values.js';

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

function writeRoot(expression: ts.Expression): ts.Identifier | undefined {
  expression = unwrap(expression);
  while (!ts.isIdentifier(expression)) {
    const receiver = memberReceiver(expression);
    if (!receiver) return undefined;
    expression = unwrap(receiver);
  }
  return expression;
}

function assignmentTargetHasSymbol(
  target: ts.Expression,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  target = unwrap(target);
  const root = writeRoot(target);
  if (root && checker.getSymbolAtLocation(root) === symbol) return true;
  if (ts.isArrayLiteralExpression(target)) return target.elements.some(element =>
    !ts.isOmittedExpression(element)
    && assignmentTargetHasSymbol(ts.isSpreadElement(element) ? element.expression : element, symbol, checker));
  if (ts.isObjectLiteralExpression(target)) return target.properties.some(member => {
    if (ts.isPropertyAssignment(member)) return assignmentTargetHasSymbol(member.initializer, symbol, checker);
    if (ts.isShorthandPropertyAssignment(member)) return checker.getShorthandAssignmentValueSymbol(member) === symbol;
    return ts.isSpreadAssignment(member) && assignmentTargetHasSymbol(member.expression, symbol, checker);
  });
  if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    return assignmentTargetHasSymbol(target.left, symbol, checker);
  }
  const branches = wrappedExpressionBranches(target);
  if (branches) return branches.some(branch => assignmentTargetHasSymbol(branch, symbol, checker));
  return false;
}

function expressionMayEvaluateToSymbol(
  expression: ts.Expression,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  expression = unwrap(expression);
  if (ts.isIdentifier(expression)) return checker.getSymbolAtLocation(expression) === symbol;
  const branches = wrappedExpressionBranches(expression);
  return branches?.some(branch => expressionMayEvaluateToSymbol(branch, symbol, checker)) ?? false;
}

const REFLECTIVE_WRITERS = {
  Object: new Set(['assign', 'defineProperty', 'defineProperties', 'setPrototypeOf']),
  Reflect: new Set(['set', 'defineProperty', 'deleteProperty', 'setPrototypeOf']),
} as const;

function referencesIntrinsic(
  expression: ts.Expression,
  intrinsic: keyof typeof REFLECTIVE_WRITERS,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  expression = unwrap(expression);
  if (ts.isIdentifier(expression)) {
    if (expression.text === intrinsic) return true;
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    const binding = symbol.declarations?.find(ts.isBindingElement);
    if (binding?.initializer
      && referencesIntrinsic(binding.initializer, intrinsic, checker, new Set(seen))) return true;
    if (binding) {
      const source = bindingSource(binding);
      if (source) {
        const values = [
          aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen)),
          ...bindingDefaultValues(source, checker, new Set(seen)),
        ].filter((value): value is NonNullable<typeof value> => value !== undefined);
        if (values.some(value => referencesIntrinsic(
          value.value,
          intrinsic,
          checker,
          new Set(seen),
        ))) return true;
      }
    }
    const declaration = symbol.declarations?.find(ts.isVariableDeclaration);
    return declaration?.initializer !== undefined
      && referencesIntrinsic(declaration.initializer, intrinsic, checker, seen);
  }
  const memberSeen = new Set(seen);
  const member = aggregateExpressionValue(expression, checker, memberSeen);
  if (member && referencesIntrinsic(member.value, intrinsic, checker, memberSeen)) return true;
  const branches = wrappedExpressionBranches(expression);
  return branches?.some(branch => referencesIntrinsic(branch, intrinsic, checker, new Set(seen))) ?? false;
}

function reflectiveWriter(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): { intrinsic: keyof typeof REFLECTIVE_WRITERS; name: string } | undefined {
  const name = memberName(expression);
  const receiver = memberReceiver(expression);
  if (!name || !receiver) return undefined;
  const entry = (Object.entries(REFLECTIVE_WRITERS) as Array<[
    keyof typeof REFLECTIVE_WRITERS,
    ReadonlySet<string>,
  ]>).find(([intrinsic, names]) => names.has(name)
    && referencesIntrinsic(receiver, intrinsic, checker, new Set(seen)));
  return entry ? { intrinsic: entry[0], name } : undefined;
}

function directReflectiveWriterTargets(
  node: ts.Node,
  checker: ts.TypeChecker,
): readonly number[] | undefined {
  if (!ts.isCallExpression(node)) return undefined;
  const writer = reflectiveWriter(node.expression, checker, new Set());
  if (!writer) return undefined;
  return writer.intrinsic === 'Reflect' && writer.name === 'set' ? [0, 3] : [0];
}

function referencesReflectiveWriter(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  expression = unwrap(expression);
  if (reflectiveWriter(expression, checker, seen)) return true;
  if (ts.isIdentifier(expression)) {
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol || seen.has(symbol)) return false;
    seen.add(symbol);
    const binding = symbol.declarations?.find(ts.isBindingElement);
    if (binding?.initializer
      && referencesReflectiveWriter(binding.initializer, checker, new Set(seen))) return true;
    if (binding) {
      const source = bindingSource(binding);
      if (source) {
        const values = [
          aggregateValueAtPath(source.initializer, source.path, checker, new Set(seen)),
          ...bindingDefaultValues(source, checker, new Set(seen)),
        ].filter((value): value is NonNullable<typeof value> => value !== undefined);
        if (values.some(value => referencesReflectiveWriter(value.value, checker, new Set(seen)))) return true;
        const name = source.path.at(-1);
        if (typeof name === 'string') {
          const receiverPath = source.path.slice(0, -1);
          const receiver = receiverPath.length === 0
            ? source.initializer
            : aggregateValueAtPath(source.initializer, receiverPath, checker, new Set(seen))?.value;
          if (receiver && (Object.entries(REFLECTIVE_WRITERS) as Array<[
            keyof typeof REFLECTIVE_WRITERS,
            ReadonlySet<string>,
          ]>).some(([intrinsic, names]) => names.has(name)
            && referencesIntrinsic(receiver, intrinsic, checker, new Set(seen)))) return true;
        }
      }
    }
    const declaration = symbol.declarations?.find(ts.isVariableDeclaration);
    return declaration?.initializer !== undefined
      && referencesReflectiveWriter(declaration.initializer, checker, seen);
  }
  const memberSeen = new Set(seen);
  const member = aggregateExpressionValue(expression, checker, memberSeen);
  if (member && referencesReflectiveWriter(member.value, checker, memberSeen)) return true;
  const branches = wrappedExpressionBranches(expression);
  if (branches) return branches.some(branch => referencesReflectiveWriter(branch, checker, new Set(seen)));
  const receiver = memberReceiver(expression);
  if (receiver && ['call', 'apply', 'bind'].includes(memberName(expression) ?? '')) {
    return referencesReflectiveWriter(receiver, checker, seen);
  }
  return ts.isCallExpression(expression)
    ? referencesReflectiveWriter(expression.expression, checker, seen)
    : false;
}

function nodeReferencesSymbol(node: ts.Node, symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) return true;
  let found = false;
  ts.forEachChild(node, child => {
    if (!found && nodeReferencesSymbol(child, symbol, checker)) found = true;
  });
  return found;
}

export function symbolHasWrites(
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  if (seen.has(symbol)) return false;
  seen.add(symbol);
  const source = symbol.valueDeclaration?.getSourceFile() ?? symbol.declarations?.[0]?.getSourceFile();
  if (!source) return true;
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    let target: ts.Expression | undefined;
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment
      && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) target = node.left;
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node))
      && (node.operator === ts.SyntaxKind.PlusPlusToken
        || node.operator === ts.SyntaxKind.MinusMinusToken)) target = node.operand;
    if (target && assignmentTargetHasSymbol(target, symbol, checker)) {
      found = true;
      return;
    }
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node))
      && !ts.isVariableDeclarationList(node.initializer)
      && assignmentTargetHasSymbol(node.initializer, symbol, checker)) {
      found = true;
      return;
    }
    const reflectiveTargets = directReflectiveWriterTargets(node, checker);
    if (reflectiveTargets && ts.isCallExpression(node)) {
      if (reflectiveTargets.some(index => {
        const target = node.arguments[index];
        return !!target && assignmentTargetHasSymbol(target, symbol, checker);
      })) {
        found = true;
        return;
      }
    } else if (ts.isCallExpression(node) && referencesReflectiveWriter(node.expression, checker)
      && node.arguments.some(argument => nodeReferencesSymbol(argument, symbol, checker))) {
      // Once a reflective writer has escaped through call/apply/bind or an alias,
      // its target position is no longer uniformly represented in the AST.
      // Treat any receiver passed into that invocation as escaped rather than
      // trusting a trailing model pair after a possible reflective write.
      found = true;
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && memberReceiver(node.left) && expressionMayEvaluateToSymbol(node.right, symbol, checker)) {
      found = true;
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (expressionMayEvaluateToSymbol(node.initializer, symbol, checker)) {
        const alias = checker.getSymbolAtLocation(node.name);
        if (!alias || symbolHasWrites(alias, checker, seen)) {
          found = true;
          return;
        }
      }
    }
    if (ts.isPropertyAssignment(node) && expressionMayEvaluateToSymbol(node.initializer, symbol, checker)) {
      found = true;
      return;
    }
    if (ts.isShorthandPropertyAssignment(node)
      && checker.getShorthandAssignmentValueSymbol(node) === symbol) {
      found = true;
      return;
    }
    if (ts.isArrayLiteralExpression(node) && node.elements.some(element => {
      const value = ts.isSpreadElement(element) ? element.expression : element;
      return !ts.isOmittedExpression(value) && expressionMayEvaluateToSymbol(value, symbol, checker);
    })) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
