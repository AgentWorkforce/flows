import ts from 'typescript';
import {
  assignmentMayStoreRight,
  bindingSource,
} from './shipped-source-binding-provenance.js';
import {
  aggregateValueAtPath,
  assignedValues,
  bindingDefaultValues,
  staticMemberSegment,
  wrappedExpressionBranches,
} from './shipped-source-binding-values.js';
import {
  directReflectiveWriterTargets,
  referencesReflectiveWriter,
} from './shipped-source-reflective-writers.js';

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

function expressionMayExposeSymbol(
  expression: ts.Expression,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  expression = unwrap(expression);
  if (ts.isSpreadElement(expression)) {
    return expressionMayExposeSymbol(expression.expression, symbol, checker);
  }
  if (expressionMayEvaluateToSymbol(expression, symbol, checker)) return true;
  const branches = wrappedExpressionBranches(expression);
  if (branches) return branches.some(branch => expressionMayExposeSymbol(branch, symbol, checker));
  if (ts.isCallExpression(expression) || ts.isNewExpression(expression)) {
    const argumentsArray = expression.arguments ?? [];
    return argumentsArray.some(argument => expressionMayExposeSymbol(argument, symbol, checker));
  }
  if (ts.isArrayLiteralExpression(expression)) return expression.elements.some(element =>
    !ts.isOmittedExpression(element)
    && expressionMayExposeSymbol(
      ts.isSpreadElement(element) ? element.expression : element,
      symbol,
      checker,
    ));
  if (ts.isObjectLiteralExpression(expression)) return expression.properties.some(member => {
    if (ts.isPropertyAssignment(member)) {
      return expressionMayExposeSymbol(member.initializer, symbol, checker);
    }
    if (ts.isShorthandPropertyAssignment(member)) {
      return checker.getShorthandAssignmentValueSymbol(member) === symbol;
    }
    return ts.isSpreadAssignment(member)
      && expressionMayExposeSymbol(member.expression, symbol, checker);
  });
  return false;
}

function nodeReferencesSymbol(node: ts.Node, symbol: ts.Symbol, checker: ts.TypeChecker): boolean {
  if (ts.isIdentifier(node) && checker.getSymbolAtLocation(node) === symbol) return true;
  let found = false;
  ts.forEachChild(node, child => {
    if (!found && nodeReferencesSymbol(child, symbol, checker)) found = true;
  });
  return found;
}

function symbolMayAliasSymbol(
  candidate: ts.Symbol,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): boolean {
  if (candidate === symbol) return true;
  if (seen.has(candidate)) return false;
  const nextSeen = new Set(seen);
  nextSeen.add(candidate);
  for (const declaration of candidate.declarations ?? []) {
    if (ts.isVariableDeclaration(declaration) && declaration.initializer
      && expressionMayAliasSymbol(
        declaration.initializer,
        symbol,
        checker,
        new Set(nextSeen),
      )) return true;
    if (!ts.isBindingElement(declaration)) continue;
    if (declaration.initializer && expressionMayAliasSymbol(
      declaration.initializer,
      symbol,
      checker,
      new Set(nextSeen),
    )) return true;
    const source = bindingSource(declaration, checker);
    if (!source) continue;
    const values = [
      aggregateValueAtPath(source.initializer, source.path, checker, new Set(nextSeen)),
      ...bindingDefaultValues(source, checker, new Set(nextSeen)),
    ].filter((value): value is NonNullable<typeof value> => value !== undefined);
    if (values.some(value => expressionMayAliasSymbol(
      value.value,
      symbol,
      checker,
      new Set(nextSeen),
    ))) return true;
  }
  return assignedValues(candidate, checker).some(value =>
    expressionMayAliasSymbol(value, symbol, checker, new Set(nextSeen)));
}

function expressionMayAliasSymbol(
  expression: ts.Expression,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen = new Set<ts.Symbol>(),
): boolean {
  expression = unwrap(expression);
  if (ts.isSpreadElement(expression)) {
    return expressionMayAliasSymbol(expression.expression, symbol, checker, seen);
  }
  if (ts.isIdentifier(expression)) {
    const candidate = checker.getSymbolAtLocation(expression);
    return candidate !== undefined && symbolMayAliasSymbol(candidate, symbol, checker, seen);
  }
  const branches = wrappedExpressionBranches(expression);
  if (branches) {
    return branches.some(branch => expressionMayAliasSymbol(
      branch,
      symbol,
      checker,
      new Set(seen),
    ));
  }
  if (ts.isArrayLiteralExpression(expression)) return expression.elements.some(element =>
    !ts.isOmittedExpression(element)
    && expressionMayAliasSymbol(element, symbol, checker, new Set(seen)));
  if (ts.isObjectLiteralExpression(expression)) return expression.properties.some(member => {
    if (ts.isPropertyAssignment(member)) {
      return expressionMayAliasSymbol(member.initializer, symbol, checker, new Set(seen));
    }
    if (ts.isShorthandPropertyAssignment(member)) {
      const candidate = checker.getShorthandAssignmentValueSymbol(member);
      return candidate !== undefined && symbolMayAliasSymbol(candidate, symbol, checker, new Set(seen));
    }
    return ts.isSpreadAssignment(member)
      && expressionMayAliasSymbol(member.expression, symbol, checker, new Set(seen));
  });
  return false;
}

function functionReturnsSymbol(
  declaration: ts.FunctionLikeDeclaration,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
): boolean {
  if (!('body' in declaration) || !declaration.body) return true;
  if (!ts.isBlock(declaration.body)) {
    return expressionMayAliasSymbol(declaration.body, symbol, checker);
  }
  let found = false;
  const visit = (node: ts.Node): void => {
    if (found) return;
    if (node !== declaration.body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression
      && expressionMayAliasSymbol(node.expression, symbol, checker)) {
      found = true;
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(declaration.body);
  return found;
}

function ordinaryCallMayWriteSymbol(
  node: ts.CallExpression,
  symbol: ts.Symbol,
  checker: ts.TypeChecker,
  seen: Set<ts.Symbol>,
): boolean {
  const argumentIndexes = node.arguments.flatMap((argument, index) =>
    expressionMayExposeSymbol(argument, symbol, checker) ? [index] : []);
  if (argumentIndexes.length === 0) return false;
  if (argumentIndexes.some(index => ts.isSpreadElement(node.arguments[index]!))) {
    // A spread's AST position does not identify the formal parameter that
    // receives the exposed receiver after runtime expansion.
    return true;
  }

  const helperName = memberName(node.expression, checker);
  const helperReceiver = memberReceiver(node.expression);
  const root = helperReceiver ? writeRoot(helperReceiver) : undefined;
  const filteredIndexes = helperName && ['call', 'apply', 'bind'].includes(helperName)
    && root && checker.getSymbolAtLocation(root) === symbol
    ? argumentIndexes.filter(index => index !== 0)
    : argumentIndexes;
  if (filteredIndexes.length === 0) return false;

  const declaration = checker.getResolvedSignature(node)?.declaration;
  if (!declaration || !ts.isFunctionLike(declaration)
    || !('body' in declaration) || !declaration.body) return true;
  for (const index of filteredIndexes) {
    const rest = declaration.parameters.at(-1)?.dotDotDotToken
      ? declaration.parameters.at(-1)
      : undefined;
    const parameter = declaration.parameters[index] ?? rest;
    if (!parameter || !ts.isIdentifier(parameter.name)) return true;
    const parameterSymbol = checker.getSymbolAtLocation(parameter.name);
    if (!parameterSymbol
      || symbolHasWrites(parameterSymbol, checker, new Set(seen))
      || functionReturnsSymbol(declaration, parameterSymbol, checker)) return true;
  }
  return false;
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
    if (ts.isCallExpression(node) && ordinaryCallMayWriteSymbol(node, symbol, checker, seen)) {
      // Passing a receiver to an ordinary callable lets that callable replace
      // agent/llm before a later syntactically pinned invocation. Without
      // whole-program effect analysis, treat the escape as a possible write.
      found = true;
      return;
    }
    if (ts.isBinaryExpression(node) && assignmentMayStoreRight(node.operatorToken.kind)
      && memberReceiver(node.left) && expressionMayEvaluateToSymbol(node.right, symbol, checker)) {
      found = true;
      return;
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (expressionMayAliasSymbol(node.initializer, symbol, checker)) {
        const alias = checker.getSymbolAtLocation(node.name);
        if (!alias || symbolHasWrites(alias, checker, seen)) {
          found = true;
          return;
        }
      }
    }
    if (ts.isBinaryExpression(node) && assignmentMayStoreRight(node.operatorToken.kind)) {
      const aliasTarget = unwrap(node.left);
      if (ts.isIdentifier(aliasTarget)
        && expressionMayAliasSymbol(node.right, symbol, checker)) {
        const alias = checker.getSymbolAtLocation(aliasTarget);
        if (!alias || alias !== symbol && symbolHasWrites(alias, checker, seen)) {
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
