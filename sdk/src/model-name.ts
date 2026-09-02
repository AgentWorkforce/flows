/**
 * Validate model declaration syntax only. Existence is proven separately by
 * the exact project allowlist and the model-scoped CLI preflight; this helper
 * deliberately does not infer providers or accept names by pattern.
 */
export function modelNameError(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.length === 0) {
    return 'expected a non-empty string';
  }
  if (value !== value.trim()) {
    return 'expected a trimmed string';
  }
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) {
      return 'must not contain control characters';
    }
  }
  return undefined;
}
