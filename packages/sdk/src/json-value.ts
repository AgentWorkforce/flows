import { isProxy } from 'node:util/types';

const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_PUSH = Function.prototype.call.bind(Array.prototype.push) as <T>(array: T[], value: T) => number;
const ARRAY_PROTOTYPE = Array.prototype;
const ERROR = Error;
const JSON_STRINGIFY = JSON.stringify;
const NUMBER = Number;
const NUMBER_IS_FINITE = Number.isFinite;
const NUMBER_IS_INTEGER = Number.isInteger;
const OBJECT_CREATE = Object.create;
const OBJECT_DEFINE_PROPERTY = Object.defineProperty;
const OBJECT_FREEZE = Object.freeze;
const OBJECT_GET_OWN_PROPERTY_DESCRIPTOR = Object.getOwnPropertyDescriptor;
const OBJECT_GET_PROTOTYPE_OF = Object.getPrototypeOf;
const OBJECT_HAS_OWN = Object.hasOwn;
const OBJECT_PROTOTYPE = Object.prototype;
const REGEXP_TEST = Function.prototype.call.bind(RegExp.prototype.test) as (
  regexp: RegExp, value: string,
) => boolean;
const STRING = String;
const STRING_CHAR_CODE_AT = Function.prototype.call.bind(String.prototype.charCodeAt) as (
  value: string, index: number,
) => number;
const WEAK_SET = WeakSet;
const WEAK_SET_ADD = Function.prototype.call.bind(WeakSet.prototype.add) as <T extends object>(
  set: WeakSet<T>, value: T,
) => WeakSet<T>;
const WEAK_SET_DELETE = Function.prototype.call.bind(WeakSet.prototype.delete) as <T extends object>(
  set: WeakSet<T>, value: T,
) => boolean;
const WEAK_SET_HAS = Function.prototype.call.bind(WeakSet.prototype.has) as <T extends object>(
  set: WeakSet<T>, value: T,
) => boolean;

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export interface JsonSnapshotLimits {
  readonly maxDepth: number;
  readonly maxNodes: number;
  readonly maxBytes: number;
}

interface SnapshotBudget {
  readonly limits?: JsonSnapshotLimits;
  nodes: number;
  properties: number;
  bytes: number;
}

/** Copy runtime input into frozen, behavior-free JSON data. */
export function snapshotJsonValue(value: unknown, at: string, limits?: JsonSnapshotLimits): JsonValue {
  return snapshot(value, at, new WEAK_SET<object>(), { limits, nodes: 0, properties: 0, bytes: 0 }, 0);
}

function snapshot(
  value: unknown,
  at: string,
  ancestors: WeakSet<object>,
  budget: SnapshotBudget,
  depth: number,
): JsonValue {
  consumeNode(budget, at, depth);
  if (typeof value === 'string') {
    consumeStringBytes(budget, value, at);
    return value;
  }
  if (value === null || typeof value === 'boolean') {
    consumeBytes(budget, value === null ? 4 : value ? 4 : 5, at);
    return value;
  }
  if (typeof value === 'number') {
    if (NUMBER_IS_FINITE(value)) {
      consumeBytes(budget, STRING(value).length, at);
      return value;
    }
    throw nonJson(at, 'numbers must be finite');
  }
  if (typeof value !== 'object') {
    throw nonJson(at, `${typeof value} values are not allowed`);
  }
  // Every ordinary reflective operation on a Proxy can execute author code.
  // Node and Bun expose this trap-free brand check, so reject before touching
  // its prototype, keys, descriptors, or identity collection.
  if (isProxy(value)) throw nonJson(at, 'Proxy objects are not allowed');
  if (WEAK_SET_HAS(ancestors, value)) throw nonJson(at, 'cycles are not allowed');
  WEAK_SET_ADD(ancestors, value);
  try {
    return ARRAY_IS_ARRAY(value)
      ? snapshotArray(value, at, ancestors, budget, depth)
      : snapshotObject(value, at, ancestors, budget, depth);
  } finally {
    WEAK_SET_DELETE(ancestors, value);
  }
}

function snapshotArray(
  value: unknown[],
  at: string,
  ancestors: WeakSet<object>,
  budget: SnapshotBudget,
  depth: number,
): JsonValue[] {
  if (OBJECT_GET_PROTOTYPE_OF(value) !== ARRAY_PROTOTYPE
    || OBJECT_GET_PROTOTYPE_OF(ARRAY_PROTOTYPE) !== OBJECT_PROTOTYPE) {
    throw nonJson(at, 'only arrays with the intrinsic prototype are allowed');
  }
  consumeBytes(budget, 2, at);
  if (budget.limits !== undefined && value.length > budget.limits.maxNodes - budget.nodes) {
    throw nonJson(at, 'snapshot depth or node limit exceeded');
  }
  // `Reflect.ownKeys` allocates the complete key list before a caller can
  // enforce cardinality. Enumerate JSON-visible keys one at a time instead.
  // Symbols and non-enumerable properties are deliberately ignored, matching
  // JSON.stringify; the copied value has neither, so they cannot affect later
  // validation or serialization.
  for (const key in value) {
    consumeProperty(budget, at);
    if (!OBJECT_HAS_OWN(value, key)) continue;
    if (!isArrayIndex(key, value.length)) {
      throw nonJson(at, 'arrays may contain only indexed data');
    }
  }
  const out: JsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    if (index > 0) consumeBytes(budget, 1, at);
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, STRING(index));
    if (descriptor === undefined) throw nonJson(`${at}[${index}]`, 'array holes are not allowed');
    ARRAY_PUSH(out, snapshotDescriptor(descriptor, `${at}[${index}]`, ancestors, budget, depth + 1));
  }
  // JSON.stringify consults `toJSON` before applying array semantics. Shadow
  // any poisoned Array.prototype hook with inert, non-JSON-visible data while
  // retaining the intrinsic prototype expected by downstream array consumers.
  OBJECT_DEFINE_PROPERTY(out, 'toJSON', { value: undefined });
  return OBJECT_FREEZE(out) as unknown as JsonValue[];
}

function snapshotObject(
  value: object,
  at: string,
  ancestors: WeakSet<object>,
  budget: SnapshotBudget,
  depth: number,
): { [key: string]: JsonValue } {
  const prototype = OBJECT_GET_PROTOTYPE_OF(value);
  if (prototype !== OBJECT_PROTOTYPE && prototype !== null) {
    throw nonJson(at, 'only plain objects are allowed');
  }
  consumeBytes(budget, 2, at);
  const out = OBJECT_CREATE(null) as { [key: string]: JsonValue };
  let included = 0;
  // Avoid materializing an attacker-sized key array in the unsandboxed
  // parent. This visits only JSON-visible own string properties; symbols and
  // non-enumerable properties are omitted exactly as JSON.stringify omits
  // them, and cannot influence the null-prototype copy.
  for (const key in value) {
    consumeProperty(budget, at);
    if (!OBJECT_HAS_OWN(value, key)) continue;
    const childAt = propertyPath(at, key);
    const descriptor = OBJECT_GET_OWN_PROPERTY_DESCRIPTOR(value, key);
    if (descriptor === undefined) throw nonJson(childAt, 'missing property descriptor');
    const child = descriptorValue(descriptor, childAt);
    // JSON.stringify and the pre-existing compiler omit undefined object
    // optionals. Arrays remain strict because undefined there becomes null.
    if (child === undefined) continue;
    if (included > 0) consumeBytes(budget, 1, at);
    consumeStringBytes(budget, key, childAt);
    consumeBytes(budget, 1, childAt);
    out[key] = snapshot(child, childAt, ancestors, budget, depth + 1);
    included += 1;
  }
  return OBJECT_FREEZE(out);
}

function snapshotDescriptor(
  descriptor: PropertyDescriptor,
  at: string,
  ancestors: WeakSet<object>,
  budget: SnapshotBudget,
  depth: number,
): JsonValue {
  return snapshot(descriptorValue(descriptor, at), at, ancestors, budget, depth);
}

function descriptorValue(descriptor: PropertyDescriptor, at: string): unknown {
  if (!descriptor.enumerable) throw nonJson(at, 'non-enumerable properties are not allowed');
  if (!('value' in descriptor)) throw nonJson(at, 'accessors are not allowed');
  return descriptor.value;
}

function isArrayIndex(key: string, length: number): boolean {
  const index = NUMBER(key);
  return NUMBER_IS_INTEGER(index) && index >= 0 && index < length && STRING(index) === key;
}

function propertyPath(at: string, key: string): string {
  if (key.length > 100) return `${at}[long property]`;
  return REGEXP_TEST(/^[A-Za-z_$][A-Za-z0-9_$]*$/, key)
    ? `${at}.${key}`
    : `${at}[${JSON_STRINGIFY(key)}]`;
}

function consumeNode(budget: SnapshotBudget, at: string, depth: number): void {
  budget.nodes += 1;
  if (budget.limits !== undefined
    && (depth > budget.limits.maxDepth || budget.nodes > budget.limits.maxNodes)) {
    throw nonJson(at, 'snapshot depth or node limit exceeded');
  }
}

function consumeProperty(budget: SnapshotBudget, at: string): void {
  if (budget.limits === undefined) return;
  budget.properties += 1;
  if (budget.properties > budget.limits.maxNodes) {
    throw nonJson(at, 'snapshot depth or node limit exceeded');
  }
}

/** Count JSON's UTF-8 string encoding without allocating the escaped value. */
function consumeStringBytes(budget: SnapshotBudget, value: string, at: string): void {
  consumeBytes(budget, 2, at);
  if (budget.limits !== undefined && value.length > budget.limits.maxBytes - budget.bytes) {
    throw nonJson(at, 'snapshot byte limit exceeded');
  }
  for (let index = 0; index < value.length; index += 1) {
    const code = STRING_CHAR_CODE_AT(value, index);
    if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
      || code === 0x0a || code === 0x0c || code === 0x0d) {
      consumeBytes(budget, 2, at);
    } else if (code < 0x20 || (code >= 0xd800 && code <= 0xdfff)) {
      if (code >= 0xd800 && code <= 0xdbff && index + 1 < value.length) {
        const low = STRING_CHAR_CODE_AT(value, index + 1);
        if (low >= 0xdc00 && low <= 0xdfff) {
          consumeBytes(budget, 4, at);
          index += 1;
          continue;
        }
      }
      consumeBytes(budget, 6, at);
    } else if (code < 0x80) consumeBytes(budget, 1, at);
    else if (code < 0x800) consumeBytes(budget, 2, at);
    else consumeBytes(budget, 3, at);
  }
}

function consumeBytes(budget: SnapshotBudget, bytes: number, at: string): void {
  budget.bytes += bytes;
  if (budget.limits !== undefined && budget.bytes > budget.limits.maxBytes) {
    throw nonJson(at, 'snapshot byte limit exceeded');
  }
}

function nonJson(at: string, detail: string): Error {
  return new ERROR(`${at}: expected JSON-compatible data; ${detail}`);
}
