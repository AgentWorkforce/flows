/**
 * The small semver subset plugin `compat` ranges may use. Deliberately not a
 * dependency on `semver`: a plugin's compatibility claim has to be checkable by
 * every reader — Cloud, the CLI, a catalog — from one short, obvious rule.
 *
 * Accepted: `*`, `x.y.z`, `^x.y.z`, `~x.y.z`, `>=x.y.z`, `>=x.y.z <a.b.c`.
 * Prerelease tags are ordered lexically after the numeric triple and only
 * compare against a range whose bounds name the same triple.
 */
const VERSION = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;
const RANGE = /^(\*|(?:[\^~]|>=)?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?: <\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)?)$/;

interface Parsed { readonly triple: readonly [number, number, number]; readonly pre?: string }

export function parseVersion(value: string): Parsed | undefined {
  const m = VERSION.exec(value);
  if (!m) return undefined;
  const triple = [Number(m[1]), Number(m[2]), Number(m[3])] as const;
  if (triple.some(n => !Number.isSafeInteger(n))) return undefined;
  return m[4] === undefined ? { triple } : { triple, pre: m[4] };
}

export function isVersionRange(value: string): boolean {
  return RANGE.test(value);
}

function compare(a: Parsed, b: Parsed): number {
  for (let i = 0; i < 3; i++) if (a.triple[i] !== b.triple[i]) return a.triple[i]! - b.triple[i]!;
  if (a.pre === b.pre) return 0;
  if (a.pre === undefined) return 1;
  if (b.pre === undefined) return -1;
  return comparePrerelease(a.pre, b.pre);
}

function comparePrerelease(a: string, b: string): number {
  const as = a.split('.');
  const bs = b.split('.');
  const n = Math.max(as.length, bs.length);
  for (let i = 0; i < n; i++) {
    const left = as[i];
    const right = bs[i];
    if (left === undefined) return -1;
    if (right === undefined) return 1;
    const leftNum = /^\d+$/.test(left) ? Number(left) : undefined;
    const rightNum = /^\d+$/.test(right) ? Number(right) : undefined;
    if (leftNum !== undefined && rightNum !== undefined) {
      if (leftNum !== rightNum) return leftNum - rightNum;
      continue;
    }
    if (leftNum !== undefined) return -1;
    if (rightNum !== undefined) return 1;
    if (left !== right) return left < right ? -1 : 1;
  }
  return 0;
}

/** Whether `version` satisfies `range`; false for malformed input rather than a throw. */
export function satisfiesRange(version: string, range: string): boolean {
  const v = parseVersion(version);
  if (v === undefined || !isVersionRange(range)) return false;
  if (range === '*') return true;
  const [lowerText, upperText] = range.split(' ') as [string, string | undefined];
  const operator = /^[\^~]|^>=/.exec(lowerText)?.[0] ?? '';
  const lower = parseVersion(lowerText.slice(operator.length))!;
  if (compare(v, lower) < 0) return false;
  if (operator === '') return compare(v, lower) === 0;
  let upper: Parsed | undefined;
  if (upperText !== undefined) upper = parseVersion(upperText.slice(1));
  else if (operator === '^') {
    const [major, minor] = lower.triple;
    upper = major > 0 ? { triple: [major + 1, 0, 0] } : minor > 0 ? { triple: [0, minor + 1, 0] } : { triple: [0, 0, lower.triple[2] + 1] };
  } else if (operator === '~') upper = { triple: [lower.triple[0], lower.triple[1] + 1, 0] };
  return upper === undefined || compare(v, upper) < 0;
}
