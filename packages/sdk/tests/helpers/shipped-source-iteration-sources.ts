import ts from 'typescript';
import {
  assignedSourcesAtBindingName,
  type AssignedSource,
  type BindingPathSegment,
} from './shipped-source-binding-targets.js';
import {
  staticForInKeys,
  staticForOfValues,
} from './shipped-source-static-iteration-values.js';

interface IterationSourceResolvers {
  assignedSourcesAtTarget(
    target: ts.Expression,
    value: ts.Expression,
    symbol: ts.Symbol,
    checker: ts.TypeChecker,
    path?: BindingPathSegment[],
  ): AssignedSource[];
  assignmentMayStoreRight(kind: ts.SyntaxKind): boolean;
  propertyName(name: ts.PropertyName | undefined, checker: ts.TypeChecker): string | undefined;
}

function unwrap(expression: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(expression)
    || ts.isAsExpression(expression)
    || ts.isSatisfiesExpression(expression)
    || ts.isNonNullExpression(expression)
    || ts.isTypeAssertionExpression(expression)) expression = expression.expression;
  return expression;
}

function member(
  expression: ts.Expression,
): { name: string; receiver: ts.Expression } | undefined {
  expression = unwrap(expression);
  if (ts.isPropertyAccessExpression(expression)) {
    return { name: expression.name.text, receiver: expression.expression };
  }
  if (!ts.isElementAccessExpression(expression) || !expression.argumentExpression) return undefined;
  const name = unwrap(expression.argumentExpression);
  return ts.isStringLiteralLike(name)
    ? { name: name.text, receiver: expression.expression }
    : undefined;
}

export function createStaticIterationSources(resolvers: IterationSourceResolvers) {
  const cache = new WeakMap<ts.TypeChecker, WeakMap<ts.Symbol, AssignedSource[]>>();
  const resolve = (expression: ts.Identifier, checker: ts.TypeChecker): AssignedSource[] => {
    const symbol = checker.getSymbolAtLocation(expression);
    if (!symbol) return [];
    let checkerCache = cache.get(checker);
    if (!checkerCache) {
      checkerCache = new WeakMap();
      cache.set(checker, checkerCache);
    }
    const cached = checkerCache.get(symbol);
    if (cached) return cached;
    const source = symbol.valueDeclaration?.getSourceFile()
      ?? symbol.declarations?.[0]?.getSourceFile();
    if (!source) return [];
    const values: AssignedSource[] = [];
    checkerCache.set(symbol, values);
    const isTarget = (candidate: ts.Expression): boolean => {
      candidate = unwrap(candidate);
      return ts.isIdentifier(candidate) && checker.getSymbolAtLocation(candidate) === symbol;
    };
    const addMutationValues = (candidates: readonly ts.Expression[]): void => {
      for (const candidate of candidates) {
        values.push(ts.isSpreadElement(candidate)
          ? { initializer: candidate.expression, path: [] }
          : { initializer: candidate, iterationValue: true, path: [] });
      }
    };
    const addIterationValues = (
      initializer: ts.ForInitializer,
      yielded: readonly ts.Expression[],
    ): void => {
      const targets = ts.isVariableDeclarationList(initializer)
        ? initializer.declarations.map(declaration => declaration.name)
        : [initializer];
      for (const target of targets) {
        for (const value of yielded) {
          values.push(...(ts.isIdentifier(target)
            || ts.isObjectBindingPattern(target)
            || ts.isArrayBindingPattern(target)
            ? assignedSourcesAtBindingName(target, value, symbol, checker, resolvers)
            : resolvers.assignedSourcesAtTarget(target, value, symbol, checker)));
        }
      }
    };
    const visit = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer) {
        values.push(...assignedSourcesAtBindingName(
          node.name,
          node.initializer,
          symbol,
          checker,
          resolvers,
        ));
      }
      if (ts.isBinaryExpression(node)
        && resolvers.assignmentMayStoreRight(node.operatorToken.kind)) {
        values.push(...resolvers.assignedSourcesAtTarget(
          node.left,
          node.right,
          symbol,
          checker,
        ));
        const target = member(node.left);
        if (target && isTarget(target.receiver) && /^(?:0|[1-9]\d*)$/u.test(target.name)) {
          addMutationValues([node.right]);
        }
      }
      if (ts.isCallExpression(node)) {
        const target = member(node.expression);
        if (target && isTarget(target.receiver)) {
          if (target.name === 'push' || target.name === 'unshift') {
            addMutationValues(node.arguments);
          } else if (target.name === 'splice') {
            addMutationValues(node.arguments.slice(2));
          } else if (target.name === 'fill') {
            addMutationValues(node.arguments.slice(0, 1));
          }
        }
      }
      if (ts.isForOfStatement(node)) {
        addIterationValues(
          node.initializer,
          staticForOfValues(node.expression, checker, resolve),
        );
      }
      if (ts.isForInStatement(node)) {
        addIterationValues(
          node.initializer,
          staticForInKeys(node.expression, checker, resolve),
        );
      }
      ts.forEachChild(node, visit);
    };
    visit(source);
    return values;
  };
  return resolve;
}
