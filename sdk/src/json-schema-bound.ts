// Termination bound for JSON Schema declarations — the SDK half.
//
// A schema that COMPILES is not a schema whose VALIDATION terminates. The
// kernel learned this the expensive way: `jsonschema` compiles
// `$defs.a -> $defs.b -> $defs.a` happily and then recurses until the process
// aborts with SIGABRT, after the step's command has already run.
//
// This is a line-for-line mirror of `kernel/relayflowd-core/src/schema.rs`, and
// `testdata/json-schema-bound-cases.json` is the corpus both sides are pinned
// to. Kernel and SDK therefore agree on which schemas are legal by
// construction, rather than by coincidence of Ajv's catchable RangeError and
// Rust's uncatchable abort.
//
// The rule: follow only the IN-PLACE applicators, which re-apply a subschema to
// the SAME instance. A cycle among those makes no progress and cannot
// terminate. Cycles that pass through a CHILD applicator (`properties`,
// `items`, ...) consume one level of the instance per step, so they terminate,
// and they stay legal.

export const UNBOUNDED_REF_CYCLE = 'unbounded $ref cycle';

const REFERENCE_KEYWORDS = ['$ref', '$dynamicRef', '$recursiveRef'] as const;
const IN_PLACE_SINGLE = ['not', 'if', 'then', 'else'] as const;
const IN_PLACE_ARRAY = ['allOf', 'anyOf', 'oneOf'] as const;
const IN_PLACE_MAP = ['dependentSchemas', 'dependencies'] as const;
const CHILD_SINGLE = [
  'additionalItems',
  'additionalProperties',
  'contains',
  'items',
  'propertyNames',
  'unevaluatedItems',
  'unevaluatedProperties',
] as const;
const CHILD_MAP = ['properties', 'patternProperties'] as const;
const CHILD_ARRAY = ['prefixItems'] as const;

type Node = Record<string, unknown>;

const escape = (segment: string): string => segment.replace(/~/g, '~0').replace(/\//g, '~1');
const unescape = (segment: string): string => segment.replace(/~1/g, '/').replace(/~0/g, '~');
const childPointer = (pointer: string, key: string): string => `${pointer}/${escape(key)}`;
const displayPointer = (pointer: string): string => (pointer === '' ? '#' : `#${pointer}`);

const isNode = (value: unknown): value is Node =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Resolve a JSON pointer against the document root. */
function at(root: unknown, pointer: string): unknown {
  if (pointer === '') return root;
  let current: unknown = root;
  for (const raw of pointer.split('/').slice(1)) {
    const segment = unescape(raw);
    if (Array.isArray(current)) {
      const index = Number(segment);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
    } else if (isNode(current)) {
      if (!Object.prototype.hasOwnProperty.call(current, segment)) return undefined;
      current = current[segment];
    } else {
      return undefined;
    }
  }
  return current;
}

function percentDecode(input: string): string {
  try {
    return decodeURIComponent(input);
  } catch {
    return input;
  }
}

interface Scopes {
  anchors: Map<string, string>;
  hasIds: boolean;
}

function collectScopes(root: unknown): Scopes {
  const anchors = new Map<string, string>();
  let hasIds = false;
  const stack: Array<[string, unknown]> = [['', root]];
  while (stack.length > 0) {
    const [pointer, node] = stack.pop() as [string, unknown];
    if (Array.isArray(node)) {
      node.forEach((value, index) => stack.push([`${pointer}/${index}`, value]));
    } else if (isNode(node)) {
      if ('$id' in node) hasIds = true;
      for (const keyword of ['$anchor', '$dynamicAnchor'] as const) {
        const name = node[keyword];
        if (typeof name === 'string' && !anchors.has(name)) anchors.set(name, pointer);
      }
      for (const [key, value] of Object.entries(node)) {
        stack.push([childPointer(pointer, key), value]);
      }
    }
  }
  return { anchors, hasIds };
}

/** Longest pointer prefix whose node declares `$id`. */
function nearestIdBase(root: unknown, pointer: string): string {
  let best = '';
  let current = '';
  for (const segment of pointer.split('/').slice(1)) {
    current += `/${segment}`;
    const node = at(root, current);
    if (isNode(node) && '$id' in node) best = current;
  }
  return best;
}

function resolve(base: string, reference: string, anchors: Map<string, string>): string | undefined {
  if (reference === '#') return base;
  if (reference.startsWith('#/')) return `${base}/${percentDecode(reference.slice(2))}`;
  if (reference.startsWith('#')) return anchors.get(percentDecode(reference.slice(1)));
  // External, absolute or otherwise unresolvable: Ajv and `jsonschema` both
  // refuse those outright, so nothing unresolved reaches validation.
  return undefined;
}

function collectArray(node: Node, pointer: string, keyword: string, out: string[]): void {
  const value = node[keyword];
  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      out.push(`${childPointer(pointer, keyword)}/${index}`);
    }
  }
}

function collectMap(node: Node, pointer: string, keyword: string, out: string[]): void {
  const value = node[keyword];
  if (!isNode(value)) return;
  for (const [name, entry] of Object.entries(value)) {
    // draft-07 `dependencies` values may be a property-name array.
    if (isNode(entry) || typeof entry === 'boolean') {
      out.push(`${childPointer(pointer, keyword)}/${escape(name)}`);
    }
  }
}

/** Iterative DFS — the checker must not recurse, or it inherits the very
 *  unbounded recursion it exists to refuse. */
function findCycle(edges: Map<string, string[]>): string[] | undefined {
  const color = new Map<string, 'gray' | 'black'>();
  for (const start of edges.keys()) {
    if (color.has(start)) continue;
    const stack: Array<{ node: string; index: number }> = [{ node: start, index: 0 }];
    const path: string[] = [start];
    color.set(start, 'gray');
    while (stack.length > 0) {
      const top = stack[stack.length - 1] as { node: string; index: number };
      const successors = edges.get(top.node) ?? [];
      if (top.index < successors.length) {
        const next = successors[top.index] as string;
        top.index += 1;
        const seen = color.get(next);
        if (seen === 'gray') {
          const from = path.indexOf(next);
          return [...path.slice(from === -1 ? 0 : from), next];
        }
        if (seen === undefined) {
          color.set(next, 'gray');
          path.push(next);
          stack.push({ node: next, index: 0 });
        }
      } else {
        color.set(top.node, 'black');
        path.pop();
        stack.pop();
      }
    }
  }
  return undefined;
}

/**
 * Refuse a declaration whose validation is not guaranteed to terminate.
 * Returns the named refusal, or `undefined` when the schema is bounded.
 */
export function jsonSchemaBoundError(schema: unknown): string | undefined {
  if (!isNode(schema)) return undefined; // boolean schemas carry no references
  const { anchors, hasIds } = collectScopes(schema);
  const inPlace = new Map<string, string[]>();
  const seen = new Set<string>(['']);
  const queue: string[] = [''];

  while (queue.length > 0) {
    const pointer = queue.pop() as string;
    const node = at(schema, pointer);
    if (!isNode(node)) continue;
    const here: string[] = [];
    const children: string[] = [];

    for (const keyword of REFERENCE_KEYWORDS) {
      const reference = node[keyword];
      if (typeof reference !== 'string') continue;
      const base = hasIds ? nearestIdBase(schema, pointer) : '';
      const target = resolve(base, reference, anchors);
      if (target !== undefined && at(schema, target) !== undefined) here.push(target);
    }
    for (const keyword of IN_PLACE_SINGLE) {
      if (keyword in node) here.push(childPointer(pointer, keyword));
    }
    for (const keyword of IN_PLACE_ARRAY) collectArray(node, pointer, keyword, here);
    for (const keyword of IN_PLACE_MAP) collectMap(node, pointer, keyword, here);
    for (const keyword of CHILD_SINGLE) {
      const value = node[keyword];
      if (Array.isArray(value)) {
        // draft-04/07 tuple form: `items` may be an array of schemas.
        for (let index = 0; index < value.length; index += 1) {
          children.push(`${childPointer(pointer, keyword)}/${index}`);
        }
      } else if (value !== undefined) {
        children.push(childPointer(pointer, keyword));
      }
    }
    for (const keyword of CHILD_MAP) collectMap(node, pointer, keyword, children);
    for (const keyword of CHILD_ARRAY) collectArray(node, pointer, keyword, children);

    for (const next of [...here, ...children]) {
      if (!seen.has(next)) {
        seen.add(next);
        queue.push(next);
      }
    }
    // `$defs`/`definitions` are containers, not applicators: their members are
    // reachable only through a `$ref`, so an unused degenerate definition is
    // never validated and stays legal.
    if (here.length > 0) inPlace.set(pointer, here);
  }

  const cycle = findCycle(inPlace);
  if (cycle === undefined) return undefined;
  return `${UNBOUNDED_REF_CYCLE}: ${cycle
    .map(displayPointer)
    .join(' -> ')} — this cycle re-applies to the same instance, so validation would not terminate`;
}
