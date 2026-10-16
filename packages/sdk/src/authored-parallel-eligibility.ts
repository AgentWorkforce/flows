import ts from 'typescript';

const functionSource = Function.prototype.toString;

/** A closed grammar for deterministic Promise.all branches. Unknown bodies stay serial. */
export function parallelRunEligible(body: Function): boolean {
  const file = ts.createSourceFile('authored-body.js', `const body = ${functionSource.call(body)};`,
    ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  if (file.statements.length !== 1) return false;
  const declaration = file.statements[0];
  if (!declaration || !ts.isVariableStatement(declaration)) return false;
  const expression = declaration.declarationList.declarations[0]?.initializer;
  // Function expressions can obtain the context through `arguments[0]`.
  if (expression === undefined || !ts.isArrowFunction(expression) || !ts.isBlock(expression.body)
    || expression.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) !== true) return false;
  const parameter = expression.parameters[0]?.name;
  if (parameter === undefined || !ts.isIdentifier(parameter) || expression.parameters.length !== 1) return false;
  const context = parameter.text;
  const branches = new Map<string, ts.ArrowFunction>();
  const rootValues = new Set<string>();
  let groups = 0;
  let runs = 0;

  const unwrap = (node: ts.Expression): ts.Expression =>
    ts.isParenthesizedExpression(node) ? unwrap(node.expression) : node;
  const method = (node: ts.Expression, owner: string, name: string): node is ts.CallExpression => {
    const value = unwrap(node);
    return ts.isCallExpression(value) && ts.isPropertyAccessExpression(value.expression)
      && ts.isIdentifier(value.expression.expression) && value.expression.expression.text === owner
      && value.expression.name.text === name;
  };
  const pure = (node: ts.Expression, values: ReadonlySet<string>): boolean => {
    const value = unwrap(node);
    if (ts.isStringLiteral(value) || ts.isNumericLiteral(value) || ts.isNoSubstitutionTemplateLiteral(value)
      || value.kind === ts.SyntaxKind.TrueKeyword || value.kind === ts.SyntaxKind.FalseKeyword
      || value.kind === ts.SyntaxKind.NullKeyword) return true;
    if (ts.isIdentifier(value)) return values.has(value.text);
    if (ts.isTemplateExpression(value)) return value.templateSpans.every(span => pure(span.expression, values));
    if (ts.isPrefixUnaryExpression(value)) return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken,
      ts.SyntaxKind.ExclamationToken].includes(value.operator) && pure(value.operand, values);
    if (ts.isBinaryExpression(value)) return [ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken,
      ts.SyntaxKind.AsteriskToken, ts.SyntaxKind.SlashToken, ts.SyntaxKind.EqualsEqualsEqualsToken,
      ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.LessThanToken,
      ts.SyntaxKind.GreaterThanToken].includes(value.operatorToken.kind)
      && pure(value.left, values) && pure(value.right, values);
    if (ts.isConditionalExpression(value)) return pure(value.condition, values)
      && pure(value.whenTrue, values) && pure(value.whenFalse, values);
    if (ts.isElementAccessExpression(value)) return value.argumentExpression !== undefined
      && pure(value.expression, values) && pure(value.argumentExpression, values);
    if (ts.isPropertyAccessExpression(value)) return pure(value.expression, values);
    if (ts.isArrayLiteralExpression(value)) return value.elements.every(element =>
      ts.isExpression(element) && pure(element, values));
    if (ts.isObjectLiteralExpression(value)) return value.properties.every(property =>
      ts.isPropertyAssignment(property) && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
      && pure(property.initializer, values));
    return false;
  };
  const run = (node: ts.Expression, values: ReadonlySet<string>): boolean => {
    const value = unwrap(node);
    if (!method(value, context, 'run') || value.arguments.length < 1 || value.arguments.length > 2
      || !value.arguments.every(argument => pure(argument, values))) return false;
    runs++;
    return true;
  };
  const group = (node: ts.Expression, values: ReadonlySet<string>, depth: number): boolean => {
    const value = unwrap(node);
    if (!method(value, 'Promise', 'all') || value.arguments.length !== 1 || depth > 4) return false;
    groups++;
    const members = value.arguments[0]!;
    if (ts.isArrayLiteralExpression(members)) {
      if (members.elements.length < 2) return false;
      return members.elements.every(member => {
        if (!ts.isExpression(member)) return false;
        if (run(member, values)) return true;
        const call = unwrap(member);
        if (depth === 0 && ts.isCallExpression(call) && ts.isIdentifier(call.expression)
          && call.arguments.length === 0 && branches.has(call.expression.text)) {
          return branch(branches.get(call.expression.text)!, depth + 1);
        }
        if (depth === 0 && ts.isCallExpression(call) && call.arguments.length === 0
          && ts.isParenthesizedExpression(call.expression) && ts.isArrowFunction(call.expression.expression)) {
          return branch(call.expression.expression, depth + 1);
        }
        return false;
      });
    }
    return false;
  };
  const awaitStep = (node: ts.Expression, values: ReadonlySet<string>, depth: number): boolean => {
    const value = unwrap(node);
    if (!ts.isAwaitExpression(value)) return false;
    return run(value.expression, values) || group(value.expression, values, depth);
  };
  const statements = (block: ts.Block, values: Set<string>, depth: number): boolean => {
    for (const statement of block.statements) {
      if (ts.isExpressionStatement(statement)) {
        if (awaitStep(statement.expression, values, depth)) continue;
        const value = unwrap(statement.expression);
        if (depth === 0 && method(value, context, 'done') && value.arguments.length >= 1
          && value.arguments.every(argument => pure(argument, values))
          && statement === block.statements[block.statements.length - 1]) continue;
        return false;
      }
      if (ts.isReturnStatement(statement) && depth > 0 && statement.expression !== undefined
        && awaitStep(statement.expression, values, depth)) continue;
      if (!ts.isVariableStatement(statement) || (statement.declarationList.flags & ts.NodeFlags.Const) === 0) return false;
      for (const item of statement.declarationList.declarations) {
        if (!ts.isIdentifier(item.name) || item.initializer === undefined) return false;
        if (depth === 0 && ts.isArrowFunction(item.initializer)) {
          if (branches.has(item.name.text) || item.initializer.parameters.length !== 0
            || item.initializer.modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.AsyncKeyword) !== true
            ) return false;
          branches.set(item.name.text, item.initializer);
          continue;
        }
        if (!awaitStep(item.initializer, values, depth)) return false;
        values.add(item.name.text);
      }
    }
    return true;
  };
  const branch = (arrow: ts.ArrowFunction, depth: number): boolean =>
    arrow.parameters.length === 0
    && (ts.isBlock(arrow.body) ? statements(arrow.body, new Set(rootValues), depth)
      : awaitStep(arrow.body, rootValues, depth));

  if (!statements(expression.body, rootValues, 0)) return false;
  return groups > 0 && runs > 0;
}
