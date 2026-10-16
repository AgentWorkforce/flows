import ts from 'typescript';

const functionSource = Function.prototype.toString;
const arrayFrom = Array.from;

/**
 * A deliberately small admission proof for parallel deterministic children.
 * The choice is written into the root before its body runs. An unrecognized
 * program keeps the established serial scheduler and ordinal identities.
 * This is a source-shape proof, never an inference from which child finished.
 */
export function parallelRunEligible(body: Function): boolean {
  const file = ts.createSourceFile('authored-body.js', `const body = ${functionSource.call(body)};`,
    ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const declaration = file.statements[0];
  if (!declaration || !ts.isVariableStatement(declaration)) return false;
  const expression = declaration.declarationList.declarations[0]?.initializer;
  if (expression === undefined || (!ts.isArrowFunction(expression) && !ts.isFunctionExpression(expression))) return false;
  const parameter = expression.parameters[0]?.name;
  if (parameter === undefined || !ts.isIdentifier(parameter) || expression.parameters.length !== 1) return false;
  const contextName = parameter.text;
  let allCount = 0;
  let runCount = 0;
  let safe = true;
  const localFunctions = new Map<string, ts.Node>();
  const localReferences: ts.Identifier[] = [];
  const allCalls: ts.CallExpression[] = [];
  const isCall = (node: ts.Node, receiver: string, method: string): boolean =>
    ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
    && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === receiver
    && node.expression.name.text === method;
  const insideAllMember = (node: ts.Node): boolean => {
    for (let current: ts.Node | undefined = node.parent; current !== undefined; current = current.parent) {
      if (isCall(current, 'Promise', 'all')) return true;
      if (current === expression) return false;
    }
    return false;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)
      && node.initializer !== undefined && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      localFunctions.set(node.name.text, node.name);
    }
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) localFunctions.set(node.name.text, node.name);
    if (ts.isCallExpression(node)) {
      if (isCall(node, 'Promise', 'all')) {
        allCount++;
        allCalls.push(node);
        if (!ts.isAwaitExpression(node.parent) || node.parent.expression !== node) safe = false;
      }
      if (isCall(node, contextName, 'run')) {
        runCount++;
        if ((!ts.isAwaitExpression(node.parent) || node.parent.expression !== node)
          && !insideAllMember(node)) safe = false;
        for (let enclosing: ts.Node | undefined = node.parent; enclosing !== undefined && enclosing !== expression;
          enclosing = enclosing.parent) {
          if (!ts.isArrowFunction(enclosing) && !ts.isFunctionExpression(enclosing)
            && !ts.isFunctionDeclaration(enclosing)) continue;
          const owner = enclosing.parent;
          const named = ts.isFunctionDeclaration(enclosing) && enclosing.name !== undefined
            || ts.isVariableDeclaration(owner) && owner.initializer === enclosing && ts.isIdentifier(owner.name);
          const fromArray = ts.isCallExpression(owner) && owner.arguments.includes(enclosing as ts.Expression)
            && isCall(owner, 'Array', 'from') && insideAllMember(owner);
          if (!named && !fromArray) safe = false;
          break;
        }
      }
      if (ts.isIdentifier(node.expression)
        && /^(setTimeout|setInterval|setImmediate|queueMicrotask|eval)$/.test(node.expression.text)) safe = false;
      if (ts.isPropertyAccessExpression(node.expression)
        && /^(then|catch|finally)$/.test(node.expression.name.text)) safe = false;
      if (ts.isArrowFunction(node.expression) || ts.isFunctionExpression(node.expression)) safe = false;
    }
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'Promise') safe = false;
    if (ts.isVoidExpression(node)) safe = false;
    if (ts.isAwaitExpression(node)
      && !isCall(node.expression, contextName, 'run') && !isCall(node.expression, 'Promise', 'all')) safe = false;
    if (ts.isIdentifier(node) && node.text === contextName && node !== parameter) {
      const parent = node.parent;
      if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node
        || !['run', 'done'].includes(parent.name.text)
        || !ts.isCallExpression(parent.parent) || parent.parent.expression !== parent) safe = false;
    }
    if (ts.isIdentifier(node) && node.text === 'Promise' && node !== parameter) {
      const parent = node.parent;
      if (!ts.isPropertyAccessExpression(parent) || parent.expression !== node || parent.name.text !== 'all'
        || !ts.isCallExpression(parent.parent) || parent.parent.expression !== parent) safe = false;
    }
    if (ts.isIdentifier(node) && node !== parameter) localReferences.push(node);
    ts.forEachChild(node, visit);
  };
  visit(expression.body);
  for (const identifier of localReferences) {
    const declarationName = localFunctions.get(identifier.text);
    if (declarationName === undefined || identifier === declarationName) continue;
    if (!ts.isCallExpression(identifier.parent) || identifier.parent.expression !== identifier
      || !insideAllMember(identifier)) safe = false;
  }
  for (const call of allCalls) {
    const members = call.arguments[0];
    if (members === undefined || call.arguments.length !== 1) { safe = false; continue; }
    if (ts.isArrayLiteralExpression(members)) {
      if (members.elements.length < 2 || members.elements.some(member =>
        !isCall(member, contextName, 'run')
        && !(ts.isCallExpression(member) && ts.isIdentifier(member.expression)
          && localFunctions.has(member.expression.text)))) safe = false;
      continue;
    }
    if (!isCall(members, 'Array', 'from') || Array.from !== arrayFrom) { safe = false; continue; }
    const from = members as ts.CallExpression;
    const shape = from.arguments[0];
    const length = shape !== undefined && ts.isObjectLiteralExpression(shape)
      ? shape.properties.find(property => ts.isPropertyAssignment(property)
        && ts.isIdentifier(property.name) && property.name.text === 'length') : undefined;
    const size = length !== undefined && ts.isPropertyAssignment(length) && ts.isNumericLiteral(length.initializer)
      ? Number(length.initializer.text) : NaN;
    const mapper = from.arguments[1];
    if (!Number.isSafeInteger(size) || size < 2 || from.arguments.length !== 2
      || mapper === undefined || !ts.isArrowFunction(mapper)
      || !isCall(mapper.body, contextName, 'run')) safe = false;
  }
  return safe && allCount > 0 && runCount > 0;
}
