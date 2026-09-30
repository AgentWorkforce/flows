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
