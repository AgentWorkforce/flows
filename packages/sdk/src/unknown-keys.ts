/**
 * Produce author-facing diagnostics for keys outside a closed schema. A key
 * that differs only in casing/separators always matches; otherwise a small
 * edit distance catches plain misspellings.
 */
export function unknownKeyErrors(
  object: Record<string, unknown>,
  allowed: readonly string[],
  at: string,
): string[] {
  const errors: string[] = [];
  for (const key of Object.keys(object)) {
    if (allowed.includes(key)) continue;
    const suggestion = nearestKey(key, allowed);
    errors.push(
      suggestion !== null
        ? `${at}: unknown key "${key}" — did you mean "${suggestion}"?`
        : `${at}: unknown key "${key}" (expected one of ${allowed.join(' | ')})`,
    );
  }
  return errors;
}

function nearestKey(key: string, allowed: readonly string[]): string | null {
  const normalize = (value: string): string => value.toLowerCase().replace(/[_-]/g, '');
  let best: string | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of allowed) {
    if (normalize(candidate) === normalize(key)) return candidate;
    const distance = levenshtein(key.toLowerCase(), candidate.toLowerCase());
    if (distance < bestDistance) {
      bestDistance = distance;
      best = candidate;
    }
  }
  return best !== null && bestDistance <= 3 && bestDistance < best.length ? best : null;
}

function levenshtein(a: string, b: string): number {
  let previous: number[] = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const current: number[] = [i];
    for (let j = 1; j <= b.length; j++) {
      const deletion = (previous[j] ?? 0) + 1;
      const insertion = (current[j - 1] ?? 0) + 1;
      const substitution = (previous[j - 1] ?? 0) + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(deletion, insertion, substitution);
    }
    previous = current;
  }
  return previous[b.length] ?? 0;
}
