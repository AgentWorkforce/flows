import ts from 'typescript';

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

function branches(expression: ts.Expression): readonly ts.Expression[] | undefined {
  expression = unwrap(expression);
  if (ts.isConditionalExpression(expression)) return [expression.whenTrue, expression.whenFalse];
  if (ts.isBinaryExpression(expression)
    && (expression.operatorToken.kind === ts.SyntaxKind.CommaToken
      || expression.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || expression.operatorToken.kind === ts.SyntaxKind.BarBarToken
      || expression.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken)) {
    return [expression.left, expression.right];
  }
  return ts.isAwaitExpression(expression) ? [expression.expression] : undefined;
}

function variableInitializers(
  expression: ts.Identifier,
  checker: ts.TypeChecker,
): ts.Expression[] {
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol) return [];
  const values = symbol.declarations
    ?.filter(ts.isVariableDeclaration)
    .flatMap(declaration => declaration.initializer ? [declaration.initializer] : []) ?? [];
  const source = symbol.valueDeclaration?.getSourceFile() ?? symbol.declarations?.[0]?.getSourceFile();
  if (!source) return values;
  const visit = (node: ts.Node): void => {
    if (ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && ts.isIdentifier(unwrap(node.left))
      && checker.getSymbolAtLocation(unwrap(node.left)) === symbol) values.push(node.right);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return values;
}

export function staticForOfValues(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): ts.Expression[] {
  expression = unwrap(expression);
  const wrapped = branches(expression);
  if (wrapped) return wrapped.flatMap(branch => staticForOfValues(branch, checker, new Set(seen)));
  if (ts.isArrayLiteralExpression(expression)) {
    return expression.elements.flatMap(element => {
      if (ts.isOmittedExpression(element)) return [];
      return ts.isSpreadElement(element)
        ? staticForOfValues(element.expression, checker, new Set(seen))
        : [element];
    });
  }
  if (!ts.isIdentifier(expression)) return [];
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return [];
  const nextSeen = new Set(seen).add(symbol);
  return variableInitializers(expression, checker)
    .flatMap(initializer => staticForOfValues(initializer, checker, new Set(nextSeen)));
}

export function staticForInKeys(
  expression: ts.Expression,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): ts.Expression[] {
  expression = unwrap(expression);
  const wrapped = branches(expression);
  if (wrapped) return wrapped.flatMap(branch => staticForInKeys(branch, checker, new Set(seen)));
  if (ts.isObjectLiteralExpression(expression)) {
    return expression.properties.flatMap(property => {
      if (ts.isSpreadAssignment(property)) {
        return staticForInKeys(property.expression, checker, new Set(seen));
      }
      if (!property.name) return [];
      return [ts.isComputedPropertyName(property.name) ? property.name.expression : property.name];
    });
  }
  if (!ts.isIdentifier(expression)) return [];
  const symbol = checker.getSymbolAtLocation(expression);
  if (!symbol || seen.has(symbol)) return [];
  const nextSeen = new Set(seen).add(symbol);
  return variableInitializers(expression, checker)
    .flatMap(initializer => staticForInKeys(initializer, checker, new Set(nextSeen)));
}
