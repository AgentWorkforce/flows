import { parse, parseExpressionAt } from 'acorn';

/**
 * Which `f.<namespace>` helpers a flow body actually USES.
 *
 * Read from a parse, not from the text. A helper merely NAMED in a string, a
 * comment, a template quasi or a regex is not used, and declaring a
 * requirement from one refuses a flow for a mount it never touches:
 * `f.run("echo f.gitlab")`, an agent prompt naming `f.slack`, or a PR title in
 * a commit message were each enough to demand a GitLab mount.
 *
 * This was first written as a lexer that blanked comments, strings and
 * regexes. That is the wrong tool: `/` is a regex or a division depending on
 * whether the preceding token ends an expression, which is not decidable
 * without parse context, and the two shapes that ambiguity broke —
 * interpolations (`${await f.gitlab…}`) and a quote inside a regex (`/'/`) —
 * both HID real helper use, deploying a flow without its mount to fail at
 * runtime. A parser settles every one of those by construction.
 *
 * What a parser still cannot see is indirection: `const p = 'gitlab';
 * f[p].issues…` is invisible to any static reading, because it needs value
 * tracking. This scan is therefore a convenience for the literal case, never
 * the authority — `header.tools[namespace] === true` is the declaration that
 * is, and it short-circuits this entirely.
 */
export function helperNamespacesUsed(body: string, root: string): ReadonlySet<string> {
  const program = parseFlowBody(body);
  if (program === null) return textFallback(body, root);
  const used = new Set<string>();
  const scope = { rootFunctionFound: false };
  walkReferences(program, root, false, scope, (node) => {
    if (node.type !== 'MemberExpression') return;
    const object = node.object as AstNode | undefined;
    if (object?.type !== 'Identifier' || object.name !== root) return;
    const namespace = memberName(node);
    if (namespace !== undefined) used.add(namespace);
  });
  return used;
}

/** `f.slack`, `f["slack"]`, `f?.slack` — but not `f[variable]`, which is unknowable. */
function memberName(node: AstNode): string | undefined {
  const property = node.property as AstNode | undefined;
  if (property === undefined) return undefined;
  if (node.computed !== true) return property.type === 'Identifier' ? property.name : undefined;
  return property.type === 'Literal' && typeof property.value === 'string' ? property.value : undefined;
}

/**
 * Parse whatever `Function.prototype.toString()` produced.
 *
 * It can be an arrow, a function expression, an async method shorthand from an
 * object literal, or a declaration — only some of which are expressions, so
 * each shape gets a try. Types are already stripped by the time a body reaches
 * here (Node strips before evaluating, and bundlers transpile), so this is
 * plain JavaScript.
 */
function parseFlowBody(body: string): AstNode | null {
  const options = { ecmaVersion: 'latest' as const, allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true };
  // `parseExpressionAt` stops at the end of the first expression and does not
  // object to what follows, so `async post(f) { … }` parses as the identifier
  // `async` and reports success having read three characters. Every attempt
  // must therefore consume the whole source, or a method body would be walked
  // as its own name and declare no helpers at all.
  const whole = (source: string, node: AstNode): AstNode => {
    const end = typeof node.end === 'number' ? node.end : -1;
    if (end < 0 || source.slice(end).trim() !== '') throw new SyntaxError('unconsumed input');
    return node;
  };
  for (const attempt of [
    () => whole(body, parseExpressionAt(body, 0, options) as unknown as AstNode),
    () => whole(`(${body})`, parseExpressionAt(`(${body})`, 0, options) as unknown as AstNode),
    () => parse(body, options) as unknown as AstNode,
    // An object-literal method (`async post(f) { … }`) is neither expression
    // nor statement on its own; it only parses inside an object.
    () => whole(`({${body}})`, parseExpressionAt(`({${body}})`, 0, options) as unknown as AstNode),
  ]) {
    try {
      return attempt();
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Last resort when nothing parses: match the text.
 *
 * Deliberately the permissive direction. An unparseable body is a shape this
 * code does not understand, and under-reporting would deploy a flow without a
 * mount it needs and fail at the call; over-reporting only asks for a mount
 * that may go unused. Reaching here at all is a bug worth hearing about.
 */
function textFallback(body: string, root: string): ReadonlySet<string> {
  const used = new Set<string>();
  const escaped = root.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
  const pattern = new RegExp(`(?:^|[^\\w$.])${escaped}\\s*(?:\\.\\s*([\\w$]+)|\\[\\s*['"]([^'"]+)['"]\\s*\\])`, 'gu');
  for (const match of body.matchAll(pattern)) {
    const namespace = match[1] ?? match[2];
    if (namespace !== undefined) used.add(namespace);
  }
  return used;
}

type AstNode = {
  type: string;
  end?: number;
  name?: string;
  value?: unknown;
  computed?: boolean;
  [key: string]: unknown;
};

/**
 * Depth-first over references that still resolve to the outer flow context.
 *
 * A nested callback/method parameter or lexical destructuring can reuse the
 * context's spelling while binding an unrelated value. Counting its members
 * would refuse the flow for a mount it never touches. Acorn gives us binding
 * shapes, so scopes are tracked as syntax instead of guessed from text.
 */
function walkReferences(
  node: AstNode,
  root: string,
  shadowed: boolean,
  state: { rootFunctionFound: boolean },
  visit: (node: AstNode) => void,
): void {
  if (isFunction(node)) {
    const parameters = Array.isArray(node.params) ? node.params.filter(isNode) : [];
    const bindsParameter = parameters.some(parameter => patternBinds(parameter, root));
    let bodyHidden = shadowed;
    if (bindsParameter && !state.rootFunctionFound) state.rootFunctionFound = true;
    else if (bindsParameter || (isNode(node.id) && patternBinds(node.id, root)) || functionVarBinds(node, root)) {
      bodyHidden = true;
    }
    // Parameter initializers run before the function body and are outside a
    // body-level `var` scope. Keep them visible unless the parameter list
    // itself binds the root name (in which case all parameter references are
    // local to that parameter environment).
    const parameterHidden = shadowed || bindsParameter;
    for (const parameter of parameters) walkReferences(parameter, root, parameterHidden, state, visit);
    const body = isNode(node.body) ? node.body : undefined;
    if (body !== undefined) walkReferences(body, root, bodyHidden, state, visit);
    return;
  }
  let hidden = shadowed;
  if (node.type === 'BlockStatement' && blockBinds(node, root)) {
    hidden = true;
  } else if (node.type === 'CatchClause' && isNode(node.param) && patternBinds(node.param, root)) {
    hidden = true;
  }

  if (!hidden) visit(node);
  for (const key of Object.keys(node)) {
    if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
    const child = node[key];
    if (Array.isArray(child)) {
      for (const entry of child) if (isNode(entry)) walkReferences(entry, root, hidden, state, visit);
    } else if (isNode(child)) {
      walkReferences(child, root, hidden, state, visit);
    }
  }
}

function isFunction(node: AstNode): boolean {
  return node.type === 'ArrowFunctionExpression'
    || node.type === 'FunctionExpression'
    || node.type === 'FunctionDeclaration';
}

/** Lexical declarations bind across their complete block, including TDZ. */
function blockBinds(node: AstNode, root: string): boolean {
  const statements = Array.isArray(node.body) ? node.body.filter(isNode) : [];
  return statements.some((statement) => {
    if (statement.type === 'VariableDeclaration' && statement.kind !== 'var') {
      const declarations = Array.isArray(statement.declarations)
        ? statement.declarations.filter(isNode) : [];
      return declarations.some(declaration => isNode(declaration.id) && patternBinds(declaration.id, root));
    }
    return (statement.type === 'FunctionDeclaration' || statement.type === 'ClassDeclaration')
      && isNode(statement.id) && patternBinds(statement.id, root);
  });
}

/** Identifier occurrences that introduce bindings, including nested patterns. */
function patternBinds(pattern: AstNode, root: string): boolean {
  switch (pattern.type) {
    case 'Identifier':
      return pattern.name === root;
    case 'AssignmentPattern':
      return isNode(pattern.left) && patternBinds(pattern.left, root);
    case 'RestElement':
      return isNode(pattern.argument) && patternBinds(pattern.argument, root);
    case 'ArrayPattern': {
      const elements = Array.isArray(pattern.elements) ? pattern.elements : [];
      return elements.some(element => isNode(element) && patternBinds(element, root));
    }
    case 'ObjectPattern': {
      const properties = Array.isArray(pattern.properties) ? pattern.properties : [];
      return properties.some(property => {
        if (!isNode(property)) return false;
        if (property.type === 'RestElement') {
          return isNode(property.argument) && patternBinds(property.argument, root);
        }
        // Object keys are labels, not bindings. Only the value side introduces
        // the local (including a default-value AssignmentPattern's left side).
        return property.type === 'Property'
          && isNode(property.value)
          && patternBinds(property.value, root);
      });
    }
    default:
      return false;
  }
}

/** `var` is function-scoped, so a nested function's declaration hides the
 * outer flow context for its entire body, including code before the
 * declaration. Nested functions have their own var scopes and are skipped. */
function functionVarBinds(node: AstNode, root: string): boolean {
  const body = isNode(node.body) ? node.body : undefined;
  if (body === undefined) return false;
  let found = false;
  const scan = (current: AstNode): void => {
    if (found) return;
    if (current !== body && isFunction(current)) return;
    if (current.type === 'VariableDeclaration' && current.kind === 'var') {
      const declarations = Array.isArray(current.declarations)
        ? current.declarations.filter(isNode) : [];
      if (declarations.some(declaration => isNode(declaration.id) && patternBinds(declaration.id, root))) {
        found = true;
        return;
      }
    }
    for (const key of Object.keys(current)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      const child = current[key];
      if (Array.isArray(child)) {
        for (const entry of child) if (isNode(entry)) scan(entry);
      } else if (isNode(child)) {
        scan(child);
      }
      if (found) return;
    }
  };
  scan(body);
  return found;
}

function isNode(value: unknown): value is AstNode {
  return typeof value === 'object' && value !== null && typeof (value as { type?: unknown }).type === 'string';
}
