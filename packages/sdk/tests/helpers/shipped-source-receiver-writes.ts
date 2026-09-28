import ts from 'typescript';

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
  return false;
}

function expressionMayEvaluateToSymbol(
  expression: ts.Expression,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  expression = unwrap(expression);
  if (ts.isIdentifier(expression)) return checker.getSymbolAtLocation(expression) === symbol;
  if (ts.isConditionalExpression(expression)) {
    return expressionMayEvaluateToSymbol(expression.whenTrue, symbol, checker)
      || expressionMayEvaluateToSymbol(expression.whenFalse, symbol, checker);
  }
  if (ts.isBinaryExpression(expression)
    && (expression.operatorToken.kind === ts.SyntaxKind.CommaToken
      || expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return expressionMayEvaluateToSymbol(expression.left, symbol, checker)
      || expressionMayEvaluateToSymbol(expression.right, symbol, checker);
  }
  return ts.isAwaitExpression(expression)
    ? expressionMayEvaluateToSymbol(expression.expression, symbol, checker)
    : false;
}

function isObjectAssignCall(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node) || memberName(node.expression) !== 'assign') return false;
  const receiver = memberReceiver(node.expression);
  if (!receiver) return false;
  const target = unwrap(receiver);
  return ts.isIdentifier(target) && target.text === 'Object';
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
    if (isObjectAssignCall(node) && node.arguments[0]
      && assignmentTargetHasSymbol(node.arguments[0], symbol, checker)) {
      found = true;
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && memberReceiver(node.left) && expressionMayEvaluateToSymbol(node.right, symbol, checker)) {
      found = true;
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      const initializer = unwrap(node.initializer);
      if (ts.isIdentifier(initializer) && checker.getSymbolAtLocation(initializer) === symbol) {
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
