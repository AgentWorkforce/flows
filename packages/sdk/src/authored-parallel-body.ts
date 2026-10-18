import ts from 'typescript';
import { AuthoredFlowExecutionError } from './authored-flow-error.js';
import { authoredFunctionSource } from './authored-flow-lifecycle.js';
import { parallelBodySyntaxEligible, unwrapParallelExpression } from './authored-parallel-eligibility.js';

/**
 * Execute a certified body with its branch-call promises marked at the call
 * site. A combinator member is not evidence that it is a safe branch: it may
 * be a hand-built join that resolves from whichever child finishes first.
 *
 * The closed grammar has no module captures, so re-evaluating this function
 * preserves its meaning. Unknown source is refused before the first effect.
 */
export function instrumentParallelBody<T extends Function>(
  body: T,
  certifyBranch: (promise: Promise<unknown>) => void,
): T {
  const source = authoredFunctionSource(body);
  if (!parallelBodySyntaxEligible(body)) {
    throw new AuthoredFlowExecutionError('step_failed', 'parallel f.run body lost its source certificate');
  }
  const prefix = 'const body = ';
  const file = ts.createSourceFile('parallel-body.js', `${prefix}${source};`,
    ts.ScriptTarget.ES2022, true, ts.ScriptKind.JS);
  const declaration = file.statements[0];
  if (!declaration || !ts.isVariableStatement(declaration)) throw new Error('certified body parse failed');
  const arrow = declaration.declarationList.declarations[0]?.initializer;
  if (!arrow || !ts.isArrowFunction(arrow) || !ts.isBlock(arrow.body)) throw new Error('certified body changed');
  const branches = new Set<string>();
  for (const statement of arrow.body.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const item of statement.declarationList.declarations) {
      if (ts.isIdentifier(item.name) && item.initializer && ts.isArrowFunction(item.initializer)) {
        branches.add(item.name.text);
      }
    }
  }
  const calls: Array<{ start: number; end: number }> = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
      && ts.isIdentifier(node.expression.expression) && node.expression.expression.text === 'Promise'
      && node.expression.name.text === 'all' && node.arguments.length === 1) {
      const members = node.arguments[0];
      if (members && ts.isArrayLiteralExpression(members)) {
        for (const outer of members.elements) {
          if (!ts.isExpression(outer)) continue;
          const member = unwrapParallelExpression(outer);
          if (!ts.isCallExpression(member) || member.arguments.length !== 0) continue;
          const named = ts.isIdentifier(member.expression) && branches.has(member.expression.text);
          const inline = ts.isParenthesizedExpression(member.expression)
            && ts.isArrowFunction(member.expression.expression);
          if (named || inline) calls.push({ start: outer.getStart(file) - prefix.length,
            end: outer.getEnd() - prefix.length });
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(arrow);
  let instrumented = source;
  for (const { start, end } of calls.sort((left, right) => right.start - left.start)) {
    instrumented = `${instrumented.slice(0, start)}__certifyParallelBranch(${instrumented.slice(start, end)})${instrumented.slice(end)}`;
  }
  const factory = new Function('__certifyParallelBranch', `return (${instrumented});`) as
    (record: (promise: Promise<unknown>) => Promise<unknown>) => T;
  return factory((promise) => { certifyBranch(promise); return promise; });
}
