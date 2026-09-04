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

/** Split `<uri>#<fragment>`. `undefined` means no `#` at all, which is
 *  distinct from an empty fragment. */
function splitFragment(reference: string): [string, string | undefined] {
  const index = reference.indexOf('#');
  return index === -1
    ? [reference, undefined]
    : [reference.slice(0, index), reference.slice(index + 1)];
}

function stripFragment(uri: string): string {
  return splitFragment(uri)[0];
}

/** RFC 3986 section 3.1 scheme detection: absolute URI vs relative reference. */
function hasScheme(reference: string): boolean {
  return /^[A-Za-z][A-Za-z0-9+\-.]*:/.test(reference);
}

/** RFC 3986 section 5.2.4. */
function removeDotSegments(path: string): string {
  const absolute = path.startsWith('/');
  const trailing = path.endsWith('/') || path.endsWith('/.') || path.endsWith('/..');
  const out: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') out.pop();
    else out.push(segment);
  }
  let resolved = absolute ? '/' : '';
  resolved += out.join('/');
  if (trailing && !resolved.endsWith('/')) resolved += '/';
  return resolved;
}

/** Split a URI into the part a rooted path replaces and the path itself. */
function splitAuthority(uri: string): [string, string] {
  const index = uri.indexOf('://');
  if (index !== -1) {
    const after = uri.slice(index + 3);
    const slash = after.indexOf('/');
    if (slash === -1) return [uri, ''];
    return [uri.slice(0, index + 3 + slash), uri.slice(index + 3 + slash)];
  }
  const last = uri.lastIndexOf('/');
  return last === -1 ? [uri, ''] : [uri.slice(0, last + 1), uri.slice(last + 1)];
}

/**
 * RFC 3986 section 5.3 reference resolution, enough of it for schema
 * identifiers. Exactness matters less than *consistency*: every `$id` is
 * registered through this function and every `$ref` looked up through it, and
 * `collectScopes` also registers each resource under its raw `$id`, so a
 * bundled document matches regardless of normalization. Mirrors
 * `kernel/relayflowd-core/src/schema.rs::resolve_uri`.
 */
function resolveUri(base: string, reference: string): string {
  if (reference === '') return base;
  if (hasScheme(reference)) return reference;
  if (base === '') return reference;
  if (reference.startsWith('//')) {
    const scheme = base.split(':')[0] ?? '';
    return `${scheme}://${reference.slice(2)}`;
  }
  const [root, path] = splitAuthority(base);
  if (reference.startsWith('/')) return `${root}${removeDotSegments(reference)}`;
  const slash = path.lastIndexOf('/');
  const merged = slash === -1 ? `/${reference}` : `${path.slice(0, slash + 1)}${reference}`;
  return `${root}${removeDotSegments(merged)}`;
}

interface Scopes {
  /** Base URI of every resource declared in this document -> its pointer,
   *  registered under both the resolved and the raw `$id`. */
  resources: Map<string, string>;
  /** `<base URI> <anchor name>` -> pointer. Anchors are scoped to the resource
   *  that declares them, so the same name under two different `$id`s does not
   *  shadow. */
  anchors: Map<string, string>;
  /** Base URI in effect at each node pointer. */
  baseAt: Map<string, string>;
  hasIds: boolean;
}

const anchorKey = (base: string, name: string): string => `${base} ${name}`;

function collectScopes(root: unknown): Scopes {
  const resources = new Map<string, string>([['', '']]);
  const anchors = new Map<string, string>();
  const baseAt = new Map<string, string>();
  let hasIds = false;
  const stack: Array<[string, string, unknown]> = [['', '', root]];
  while (stack.length > 0) {
    const [pointer, inherited, node] = stack.pop() as [string, string, unknown];
    if (Array.isArray(node)) {
      baseAt.set(pointer, inherited);
      node.forEach((value, index) => stack.push([`${pointer}/${index}`, inherited, value]));
    } else if (isNode(node)) {
      let base = inherited;
      const declared = node['$id'] ?? node['id'];
      if (typeof declared === 'string') {
        hasIds = true;
        const raw = stripFragment(declared);
        const resolved = resolveUri(base, raw);
        if (!resources.has(resolved)) resources.set(resolved, pointer);
        if (!resources.has(raw)) resources.set(raw, pointer);
        base = resolved;
      }
      baseAt.set(pointer, base);
      for (const keyword of ['$anchor', '$dynamicAnchor', '$recursiveAnchor'] as const) {
        const name = node[keyword];
        if (typeof name === 'string' && !anchors.has(anchorKey(base, name))) {
          anchors.set(anchorKey(base, name), pointer);
        }
      }
      for (const [key, value] of Object.entries(node)) {
        stack.push([childPointer(pointer, key), base, value]);
      }
    } else {
      baseAt.set(pointer, inherited);
    }
  }
  return { resources, anchors, baseAt, hasIds };
}

/**
 * Resolve a reference to the pointer of the node it names, or `undefined` when
 * it names nothing inside this document.
 *
 * A reference naming no in-document resource is left opaque, on a claim
 * narrower than this function used to make. It is either remote -- refused by
 * the engine, which has no retriever -- or a bundled meta-schema, which cannot
 * reference back into this document and so cannot close a cycle rooted here.
 * The older, wider claim was false for an in-document `$id`, which is the gap
 * this resolver closes.
 */
function resolve(
  base: string,
  reference: string,
  resources: Map<string, string>,
  anchors: Map<string, string>,
): string | undefined {
  const [uri, fragment] = splitFragment(reference);
  let targetBase: string;
  let targetPointer: string | undefined;
  if (uri === '') {
    targetBase = base;
    targetPointer = resources.get(base);
  } else {
    const resolved = resolveUri(base, uri);
    targetPointer = resources.get(resolved);
    if (targetPointer !== undefined) {
      targetBase = resolved;
    } else {
      // Literal fallback, in case this resolver and the `$id` that registered
      // the resource normalized differently.
      targetBase = uri;
      targetPointer = resources.get(uri);
    }
  }
  if (targetPointer === undefined) return undefined;
  if (fragment === undefined || fragment === '') return targetPointer;
  if (fragment.startsWith('/')) return `${targetPointer}${percentDecode(fragment)}`;
  return anchors.get(anchorKey(targetBase, percentDecode(fragment)));
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
  const { resources, anchors, baseAt, hasIds } = collectScopes(schema);
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
      const base = hasIds ? (baseAt.get(pointer) ?? '') : '';
      const target = resolve(base, reference, resources, anchors);
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
