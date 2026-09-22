// Canonical JSON for specs — sorted keys, no whitespace, deterministic.
//
// The kernel hashes `serde_json::to_vec(to_value(spec))`; serde_json objects
// are BTreeMaps, so that is exactly this canonical form. Given the same spec
// value (a kernel-dialect spec from `toKernelSpec`), sha256 here equals the
// kernel's `spec_hash`. This is pinned by `tests/spec-parity.test.ts` and the
// kernel's `tests/spec_parity.rs` over the shared `testdata/` fixture — not
// assumed.

import { createHash } from 'node:crypto';
import { snapshotJsonValue, type JsonValue } from './json-value.js';

const ARRAY_IS_ARRAY = Array.isArray;
const ARRAY_JOIN = Function.prototype.call.bind(Array.prototype.join) as (
  array: readonly string[], separator?: string,
) => string;
const ARRAY_PUSH = Function.prototype.call.bind(Array.prototype.push) as <T>(array: T[], value: T) => number;
const ARRAY_SORT = Function.prototype.call.bind(Array.prototype.sort) as <T>(array: T[]) => T[];
const JSON_STRINGIFY = JSON.stringify;
const OBJECT_KEYS = Object.keys;

/**
 * Serialize a value as canonical JSON: object keys sorted recursively,
 * arrays in order, no whitespace. Numbers are kept as-is (tokens are
 * integers; money is a decimal string, never a float — so no float drift).
 *
 * This is an exported boundary, so runtime input is snapshotted into frozen,
 * behavior-free data before a single byte is serialized — the same guard
 * `validateSpec` and `kernelToAuthoring` use. Without it a Proxy or a plain
 * getter could return one value while the identity is computed and another
 * afterwards, and `specHash` would stamp a spec nobody ever declared.
 */
export function canonicalize(value: unknown): string {
  return serialize(snapshotJsonValue(value, 'value'));
}

/**
 * sha256 of the canonical JSON of a spec. Pass a kernel-dialect spec
 * (`toKernelSpec`) to get the identity the kernel stamps as `spec_hash`.
 */
export function specHash(spec: unknown): string {
  return createHash('sha256').update(serialize(snapshotJsonValue(spec, 'spec'))).digest('hex');
}

/**
 * Serialize an already-snapshotted value. Each key is read EXACTLY ONCE: the
 * previous `keys.filter(k => obj[k] !== undefined).map(k => … obj[k])` read
 * every property twice, which on a live getter is a TOCTOU — the filter and
 * the serialize could disagree, and two `canonicalize` calls on one object
 * could return different strings.
 */
function serialize(value: JsonValue): string {
  if (value === null || typeof value !== 'object') {
    return JSON_STRINGIFY(value);
  }
  if (ARRAY_IS_ARRAY(value)) {
    const items: string[] = [];
    for (let index = 0; index < value.length; index += 1) items[index] = serialize(value[index]!);
    return '[' + ARRAY_JOIN(items, ',') + ']';
  }
  const parts: string[] = [];
  const keys = OBJECT_KEYS(value);
  ARRAY_SORT(keys);
  for (let index = 0; index < keys.length; index += 1) {
    const key = keys[index]!;
    const child = value[key];
    if (child === undefined) continue;
    ARRAY_PUSH(parts, JSON_STRINGIFY(key) + ':' + serialize(child));
  }
  return '{' + ARRAY_JOIN(parts, ',') + '}';
}
