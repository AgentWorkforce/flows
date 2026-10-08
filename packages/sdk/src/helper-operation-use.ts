import { isFunction, isNode, memberName, parseFlowBody, walkReferences, type AstNode } from './helper-reference.js';

/**
 * Whether a flow body calls `f.<namespace>.<method>`.
 *
 * - `called`: a direct, named call such as `f.notion.appendBlock(...)`.
 * - `absent`: the namespace is only ever used directly — `f.notion.x(...)` with
 *   named methods — or read (`if (f.notion)`, `typeof`, comparisons, a discarded
 *   `f.notion && ...`), so the call provably does not occur.
 * - `unprovable`: the namespace or the whole context leaves direct use — an
 *   alias, destructuring, an argument, a return, a property, a computed member
 *   or namespace. Its later calls cannot be attributed statically, so callers
 *   that must fail closed treat this as the call.
 *
 * Same scoped parse as `helperNamespacesUsed`: strings and comments naming the
 * call are not uses, and a nested binding of the context name is not the context.
 * An unparseable body falls back to the text, permissively.
 */
export function helperOperationUse(body: string, root: string, namespace: string, method: string): 'called' | 'absent' | 'unprovable' {
  const program = parseFlowBody(body);
  if (program === null) return new RegExp(`\\.\\s*${method}\\b`).test(body) ? 'unprovable' : 'absent';
  const parents = new WeakMap<AstNode, AstNode>();
  const link = (node: AstNode): void => {
    for (const key of Object.keys(node)) {
      if (key === 'type' || key === 'start' || key === 'end' || key === 'loc') continue;
      const child = node[key];
      for (const entry of Array.isArray(child) ? child : [child]) {
        if (isNode(entry)) { parents.set(entry, node); link(entry); }
      }
    }
  };
  link(program);
  let result: 'called' | 'absent' | 'unprovable' = 'absent';
  const mark = (found: 'called' | 'unprovable') => { if (result !== 'unprovable') result = found; };
  walkReferences(program, root, false, { rootFunctionFound: false }, (node) => {
    // Prototype machinery lets the body intercept the helper wherever it is
    // coerced or inherited from (toPrimitive, a replaced Object.prototype
    // method, a Proxy), so no use of it is attributable once present.
    if ((node.type === 'MemberExpression' && node.computed !== true
        && PROTOTYPE_MACHINERY.has((node.property as AstNode).name ?? ''))
      || (node.type === 'Identifier' && (node.name === 'Reflect' || node.name === 'Proxy')
        && !declares(parents.get(node) ?? node, node))) return mark('unprovable');
    // eval and Function run source text this scan never sees.
    if ((node.type === 'CallExpression' || node.type === 'NewExpression')
      && (node.callee as AstNode).type === 'Identifier'
      && ['eval', 'Function'].includes((node.callee as AstNode).name!)) return mark('unprovable');
    // `arguments[0]` is the context in a non-arrow root body without naming it.
    if (node.type === 'Identifier' && node.name === 'arguments' && rootArguments(node, parents)) return mark('unprovable');
    if (node.type !== 'Identifier' || node.name !== root) return;
    const parent = parents.get(node);
    if (parent === undefined || declares(parent, node)) return;
    if (parent.type === 'MemberExpression' && parent.object === node) {
      const name = memberName(parent);
      if (name === undefined) return mark('unprovable'); // f[expr]
      if (name !== namespace) return;
      const grand = parents.get(parent);
      if (grand?.type === 'MemberExpression' && grand.object === parent) {
        const operation = memberName(grand);
        if (operation === undefined) mark('unprovable'); // f.notion[expr]
        else if (operation === method) {
          // Calling it is the operation; a read (typeof, comparison) is not;
          // anything else hands the function on.
          // Any use but a pure read reaches the operation: a call, however
          // wrapped (parentheses, comma, ||, ?:, new), or the function handed on.
          if (!readOrCall(grand, parents, false)) mark('called');
        }
        // Inherited object members (valueOf, constructor, toString, ...) can hand
        // the helper back — directly, or through a prototype the body replaced —
        // so none is attributable; helper methods return steps.
        else if (operation === '__proto__' || Object.prototype.hasOwnProperty.call(Object.prototype, operation)) mark('unprovable');
        return;
      }
      if (!readOrCall(parent, parents)) mark('unprovable');
      return;
    }
    // The whole context used as a value (`const { notion } = f`, `use(f)`).
    if (!readOrCall(node, parents)) mark('unprovable');
  });
  return result;
}

/** Members through which a body can reach or rewrite the prototypes every helper inherits from. */
const PROTOTYPE_MACHINERY = new Set(['prototype', '__proto__', 'defineProperty', 'defineProperties',
  'setPrototypeOf', 'getPrototypeOf', 'toPrimitive', '__defineGetter__', '__defineSetter__']);

/**
 * A use that cannot hand the value on: a discarded value or a read, and —
 * when `allowCall` — a direct call of it.
 */
function readOrCall(value: AstNode, parents: WeakMap<AstNode, AstNode>, allowCall = true): boolean {
  let current = value;
  let parent = parents.get(current);
  // Wrappers that pass their operand's value through unchanged.
  while (parent !== undefined && ['ChainExpression', 'ParenthesizedExpression', 'AwaitExpression',
    'LogicalExpression', 'ConditionalExpression', 'SequenceExpression'].includes(parent.type)
    && !(parent.type === 'ConditionalExpression' && parent.test === current)) {
    // Only a sequence's last operand is its value; earlier ones are discarded reads.
    if (parent.type === 'SequenceExpression' && (parent.expressions as AstNode[]).at(-1) !== current) return true;
    current = parent;
    parent = parents.get(current);
  }
  if (parent === undefined) return false;
  if ((parent.type === 'CallExpression' || parent.type === 'NewExpression') && parent.callee === current) return allowCall;
  // `instanceof` hands its left operand to the right side's Symbol.hasInstance.
  if (parent.type === 'BinaryExpression') return parent.operator !== 'instanceof';
  if (['ExpressionStatement', 'UnaryExpression'].includes(parent.type)) return true;
  // `${f.notion}` coerces to a string; a tagged template hands the value to its tag.
  if (parent.type === 'TemplateLiteral') return parents.get(parent)?.type !== 'TaggedTemplateExpression';
  return ['IfStatement', 'WhileStatement', 'DoWhileStatement', 'ForStatement', 'ConditionalExpression'].includes(parent.type)
    && parent.test === current;
}

/**
 * `arguments` used (not named) inside the root flow function itself — the
 * outermost non-arrow function, whatever shape its context parameter has — not
 * inside a nested non-arrow function with its own `arguments`.
 */
function rootArguments(node: AstNode, parents: WeakMap<AstNode, AstNode>): boolean {
  const parent = parents.get(node);
  if (parent !== undefined && declares(parent, node)) return false;
  let owner: AstNode | undefined;
  for (let at = parents.get(node); at !== undefined; at = parents.get(at)) {
    if (at.type === 'FunctionDeclaration' || at.type === 'FunctionExpression') { owner = at; break; }
  }
  if (owner === undefined) return false;
  for (let at = parents.get(owner); at !== undefined; at = parents.get(at)) {
    if (at.type === 'FunctionDeclaration' || at.type === 'FunctionExpression' || at.type === 'ArrowFunctionExpression') return false;
  }
  return true;
}

/** The identifier is a name being declared or a property name, not a use of the context. */
function declares(parent: AstNode, node: AstNode): boolean {
  if (isFunction(parent)) return ((parent.params as AstNode[] | undefined) ?? []).includes(node);
  if (parent.type === 'Property') return parent.key === node && parent.computed !== true && parent.shorthand !== true;
  return parent.type === 'MemberExpression' && parent.property === node && parent.computed !== true;
}
