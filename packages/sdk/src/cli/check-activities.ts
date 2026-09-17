import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { inputFailureReport, type CheckExecution } from './check.js';

/**
 * Fail closed on body-level `f.on` calls that visibly omit an end bound.
 * Dynamic options cannot be proved at check time and are refused here too;
 * runtime validation covers JS callers and values assembled at runtime.
 */
export async function checkAuthoredActivities(path: string): Promise<CheckExecution> {
  try {
    const source = await readFile(path, 'utf8');
    const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
    let diagnostic: string | undefined;
    const visit = (node: ts.Node): void => {
      if (diagnostic !== undefined) return;
      if (ts.isCallExpression(node) && isContextOn(node.expression)) {
        const options = node.arguments[1];
        if (options === undefined || !ts.isObjectLiteralExpression(options)) {
          diagnostic = 'body-level f.on() requires literal idle and deadline bounds (unbounded_subscription)';
          return;
        }
        const keys = new Set(options.properties.flatMap((property) => {
          if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property)) return [];
          return ts.isIdentifier(property.name) || ts.isStringLiteral(property.name) ? [property.name.text] : [];
        }));
        if (!keys.has('idle') || !keys.has('deadline')) {
          diagnostic = 'body-level f.on() requires both idle and deadline bounds (unbounded_subscription)';
          return;
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
    if (diagnostic !== undefined) {
      return { report: inputFailureReport({ kind: 'invalid_spec', message: diagnostic }, path) };
    }
    return { report: { ok: true, path, gates: [], resolutions: [], diagnostics: [] } };
  } catch (error) {
    return { report: inputFailureReport({ kind: 'invalid_spec',
      message: error instanceof Error ? error.message : 'Cannot inspect body-level activities' }, path) };
  }
}

function isContextOn(expression: ts.LeftHandSideExpression): boolean {
  return ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && expression.expression.text === 'f'
    && expression.name.text === 'on';
}
