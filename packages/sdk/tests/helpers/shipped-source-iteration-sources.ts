import ts from 'typescript';
import {
  assignedSourcesAtBindingName,
  type AssignedSource,
  type BindingPathSegment,
} from './shipped-source-binding-targets.js';

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
  return (expression: ts.Identifier, checker: ts.TypeChecker): AssignedSource[] => {
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
      ts.forEachChild(node, visit);
    };
    visit(source);
    checkerCache.set(symbol, values);
    return values;
  };
}
