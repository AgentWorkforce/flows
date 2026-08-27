// Canonical JSON for specs — sorted keys, no whitespace, deterministic.
//
// The kernel hashes `serde_json::to_vec(to_value(spec))`; serde_json objects
// are BTreeMaps, so that is exactly this canonical form. Given the same spec
// value (a kernel-dialect spec from `toKernelSpec`), sha256 here equals the
// kernel's `spec_hash`. This is pinned by `tests/spec-parity.test.ts` and the
// kernel's `tests/spec_parity.rs` over the shared `testdata/` fixture — not
// assumed.

import { createHash } from 'node:crypto';

/**
 * Serialize a value as canonical JSON: object keys sorted recursively,
 * arrays in order, no whitespace. Numbers are kept as-is (tokens are
 * integers; money is a decimal string, never a float — so no float drift).
 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + (value as unknown[]).map(canonicalize).join(',') + ']';
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    '{' +
    keys
      .filter((k) => obj[k] !== undefined)
      .map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k]))
      .join(',') +
    '}'
  );
}

/**
 * sha256 of the canonical JSON of a spec. Pass a kernel-dialect spec
 * (`toKernelSpec`) to get the identity the kernel stamps as `spec_hash`.
 */
export function specHash(spec: unknown): string {
  return createHash('sha256').update(canonicalize(spec)).digest('hex');
}
