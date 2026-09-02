import { isProxy } from 'node:util/types';

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Copy runtime input into frozen, behavior-free JSON data. */
export function snapshotJsonValue(value: unknown, at: string): JsonValue {
  return snapshot(value, at, new WeakSet<object>());
}

function snapshot(value: unknown, at: string, ancestors: WeakSet<object>): JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (Number.isFinite(value)) return value;
    throw nonJson(at, 'numbers must be finite');
  }
  if (typeof value !== 'object') {
    throw nonJson(at, `${typeof value} values are not allowed`);
  }
  // Every ordinary reflective operation on a Proxy can execute author code.
  // Node and Bun expose this trap-free brand check, so reject before touching
  // its prototype, keys, descriptors, or identity collection.
  if (isProxy(value)) throw nonJson(at, 'Proxy objects are not allowed');
  if (ancestors.has(value)) throw nonJson(at, 'cycles are not allowed');
  ancestors.add(value);
  try {
    return Array.isArray(value)
      ? snapshotArray(value, at, ancestors)
      : snapshotObject(value, at, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function snapshotArray(
  value: unknown[],
  at: string,
  ancestors: WeakSet<object>,
): JsonValue[] {
  const keys = Reflect.ownKeys(value);
  for (const key of keys) {
    if (key === 'length') continue;
    if (typeof key !== 'string' || !isArrayIndex(key, value.length)) {
      throw nonJson(at, 'arrays may contain only indexed data');
    }
  }
  const out: JsonValue[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
    if (descriptor === undefined) throw nonJson(`${at}[${index}]`, 'array holes are not allowed');
    out.push(snapshotDescriptor(descriptor, `${at}[${index}]`, ancestors));
  }
  return Object.freeze(out) as unknown as JsonValue[];
}

function snapshotObject(
  value: object,
  at: string,
  ancestors: WeakSet<object>,
): { [key: string]: JsonValue } {
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw nonJson(at, 'only plain objects are allowed');
  }
  const out = Object.create(null) as { [key: string]: JsonValue };
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string') throw nonJson(at, 'symbol keys are not allowed');
    const childAt = propertyPath(at, key);
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (descriptor === undefined) throw nonJson(childAt, 'missing property descriptor');
    const child = descriptorValue(descriptor, childAt);
    // JSON.stringify and the pre-existing compiler omit undefined object
    // optionals. Arrays remain strict because undefined there becomes null.
    if (child === undefined) continue;
    out[key] = snapshot(child, childAt, ancestors);
  }
  return Object.freeze(out);
}

function snapshotDescriptor(
  descriptor: PropertyDescriptor,
  at: string,
  ancestors: WeakSet<object>,
): JsonValue {
  return snapshot(descriptorValue(descriptor, at), at, ancestors);
}

function descriptorValue(descriptor: PropertyDescriptor, at: string): unknown {
  if (!descriptor.enumerable) throw nonJson(at, 'non-enumerable properties are not allowed');
  if (!('value' in descriptor)) throw nonJson(at, 'accessors are not allowed');
  return descriptor.value;
}

function isArrayIndex(key: string, length: number): boolean {
  const index = Number(key);
  return Number.isInteger(index) && index >= 0 && index < length && String(index) === key;
}

function propertyPath(at: string, key: string): string {
  return /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(key) ? `${at}.${key}` : `${at}[${JSON.stringify(key)}]`;
}

function nonJson(at: string, detail: string): Error {
  return new Error(`${at}: expected JSON-compatible data; ${detail}`);
}
