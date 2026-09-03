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
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(serialize).join(',') + ']';
  }
  const parts: string[] = [];
  for (const key of Object.keys(value).sort()) {
    const child = value[key];
    if (child === undefined) continue;
    parts.push(JSON.stringify(key) + ':' + serialize(child));
  }
  return '{' + parts.join(',') + '}';
}
