import ts from 'typescript';

export function returnedExpressions(body: ts.ConciseBody | undefined): ts.Expression[] {
  if (!body) return [];
  if (!ts.isBlock(body)) return [body];
  const values: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (node !== body && ts.isFunctionLike(node)) return;
    if (ts.isReturnStatement(node) && node.expression) {
      values.push(node.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(body);
  return values;
}
