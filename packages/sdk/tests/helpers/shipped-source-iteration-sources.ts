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
  return ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)
    ? { name: name.text, receiver: expression.expression }
    : undefined;
}

function directObjectAssignSources(
  node: ts.CallExpression,
  checker: ts.TypeChecker,
  targetPath: (candidate: ts.Expression) => BindingPathSegment[] | undefined,
  expandSpread: (candidate: ts.Expression) => readonly ts.Expression[],
): AssignedSource[] {
  const target = unwrap(node.expression);
  const receiver = node.arguments[0] && unwrap(node.arguments[0]);
  const objectIdentifier = ts.isPropertyAccessExpression(target)
    ? unwrap(target.expression)
    : undefined;
  const objectSymbol = objectIdentifier && ts.isIdentifier(objectIdentifier)
    ? checker.getSymbolAtLocation(objectIdentifier)
    : undefined;
  if (!ts.isPropertyAccessExpression(target)
    || target.name.text !== 'assign'
    || !objectIdentifier || !ts.isIdentifier(objectIdentifier)
    || objectIdentifier.text !== 'Object'
    || (objectSymbol?.declarations?.some(declaration => !declaration.getSourceFile().isDeclarationFile) ?? false)
    || !receiver) return [];
  const path = targetPath(receiver);
  if (!path) return [];
  return node.arguments.slice(1).flatMap(argument => {
    const expanded = ts.isSpreadElement(argument) ? expandSpread(argument.expression) : [];
    const initializers = ts.isSpreadElement(argument)
      ? expanded.length > 0 ? expanded : [argument.expression]
      : [argument];
    return initializers.map(initializer => ({
      initializer,
      path: [],
      ...(path.length === 0 ? {} : { targetPath: path }),
    }));
  });
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
    const targetPath = (
      candidate: ts.Expression,
      seen = new Set<ts.Symbol>(),
    ): BindingPathSegment[] | undefined => {
      candidate = unwrap(candidate);
      const targetMember = member(candidate);
      if (targetMember) {
        const parent = targetPath(targetMember.receiver, new Set(seen));
        return parent ? [...parent, targetMember.name] : undefined;
      }
      if (!ts.isIdentifier(candidate)) return undefined;
      const candidateSymbol = checker.getSymbolAtLocation(candidate);
      if (!candidateSymbol) return undefined;
      if (candidateSymbol === symbol) return [];
      if (seen.has(candidateSymbol)) return undefined;
      const nextSeen = new Set(seen).add(candidateSymbol);
      for (const source of resolve(candidate, checker)) {
        if (source.path.length > 0 || source.rest || source.targetPath) continue;
        const aliased = targetPath(source.initializer, nextSeen);
        if (aliased) return aliased;
      }
      return undefined;
    };
    const addMutationValues = (
      candidates: readonly ts.Expression[],
      path: BindingPathSegment[],
    ): void => {
      for (const candidate of candidates) {
        values.push(ts.isSpreadElement(candidate)
          ? { initializer: candidate.expression, path: [], spreadValue: true,
              ...(path.length ? { targetPath: path } : {}) }
          : { initializer: candidate, iterationValue: true, path: [], ...(path.length ? { targetPath: path } : {}) });
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
        const path = target ? targetPath(target.receiver) : undefined;
        if (target && path && /^(?:0|[1-9]\d*)$/u.test(target.name)) {
          addMutationValues([node.right], path);
        }
      }
      if (ts.isCallExpression(node)) {
        values.push(...directObjectAssignSources(
          node,
          checker,
          targetPath,
          candidate => staticForOfValues(candidate, checker, resolve),
        ));
        const target = member(node.expression);
        const path = target ? targetPath(target.receiver) : undefined;
        if (target && (target.name === 'push' || target.name === 'unshift'
          || target.name === 'splice' || target.name === 'fill')
          && path) {
          if (target.name === 'push' || target.name === 'unshift') {
            addMutationValues(node.arguments, path);
          } else if (target.name === 'splice') {
            addMutationValues(node.arguments.slice(2), path);
          } else if (target.name === 'fill') {
            addMutationValues(node.arguments.slice(0, 1), path);
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
