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
    const visit = (node: ts.Node, context: ContextNames): void => {
      if (diagnostic !== undefined) return;
      if (ts.isCallExpression(node) && isContextOn(node.expression, context)) {
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
      // A nested function that rebinds a context name is not the flow context.
      const inner = ts.isFunctionLike(node) ? shadow(context, node.parameters) : context;
      ts.forEachChild(node, (child) => visit(child, inner));
    };
    for (const body of authoredBodies(file)) {
      if (body.body !== undefined) visit(body.body, contextNames(body));
    }
    if (diagnostic !== undefined) {
      return { report: inputFailureReport({ kind: 'invalid_spec', message: diagnostic }, path) };
    }
    return { report: { ok: true, path, gates: [], resolutions: [], diagnostics: [] } };
  } catch (error) {
    return { report: inputFailureReport({ kind: 'invalid_spec',
      message: error instanceof Error ? error.message : 'Cannot inspect body-level activities' }, path) };
  }
}

interface ContextNames {
  /** Identifiers bound to a body's flow context, e.g. `f` or `ctx`. */
  readonly objects: Set<string>;
  /** Local names bound to a destructured `on`, e.g. `({ on }) => on(...)`. */
  readonly on: Set<string>;
}

type BodyFunction = ts.ArrowFunction | ts.FunctionExpression | ts.FunctionDeclaration;

/**
 * Every authored body in this file: the last function argument of a
 * `flow(...)` call and the default export, inline or named by an identifier
 * declared in the same file. Only these bodies are checked.
 */
function authoredBodies(file: ts.SourceFile): Set<BodyFunction> {
  const functions = new Map<string, BodyFunction>();
  const bodies = new Set<BodyFunction>();
  const references: string[] = [];
  const addBody = (node: ts.Node | undefined): void => {
    if (node === undefined) return;
    if (ts.isArrowFunction(node) || ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node)) bodies.add(node);
    else if (ts.isIdentifier(node)) references.push(node.text);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name !== undefined) functions.set(node.name.text, node);
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer !== undefined
      && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
      functions.set(node.name.text, node.initializer);
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'flow') {
      addBody(node.arguments[node.arguments.length - 1]);
    }
    if (ts.isExportAssignment(node) && !node.isExportEquals) addBody(node.expression);
    if (ts.isFunctionDeclaration(node) && node.modifiers?.some(m => m.kind === ts.SyntaxKind.DefaultKeyword)) addBody(node);
    ts.forEachChild(node, visit);
  };
  visit(file);
  for (const name of references) {
    const body = functions.get(name);
    if (body !== undefined) bodies.add(body);
  }
  return bodies;
}

function contextNames(body: BodyFunction): ContextNames {
  const names: ContextNames = { objects: new Set(), on: new Set() };
  const parameter = body.parameters[0]?.name;
  if (parameter === undefined) return names;
  if (ts.isIdentifier(parameter)) names.objects.add(parameter.text);
  else if (ts.isObjectBindingPattern(parameter)) {
    for (const element of parameter.elements) {
      const key = element.propertyName ?? element.name;
      if (ts.isIdentifier(key) && key.text === 'on' && ts.isIdentifier(element.name)) names.on.add(element.name.text);
    }
  }
  return names;
}

function shadow(context: ContextNames, parameters: ts.NodeArray<ts.ParameterDeclaration>): ContextNames {
  const bound = new Set<string>();
  const collect = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) bound.add(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) collect(element.name);
  };
  for (const parameter of parameters) collect(parameter.name);
  if (bound.size === 0) return context;
  return {
    objects: new Set([...context.objects].filter(name => !bound.has(name))),
    on: new Set([...context.on].filter(name => !bound.has(name))),
  };
}

function isContextOn(expression: ts.LeftHandSideExpression, context: ContextNames): boolean {
  if (ts.isIdentifier(expression)) return context.on.has(expression.text);
  return ts.isPropertyAccessExpression(expression)
    && ts.isIdentifier(expression.expression)
    && context.objects.has(expression.expression.text)
    && expression.name.text === 'on';
}
