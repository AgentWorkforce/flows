/**
 * Does a flow body actually USE `f.<namespace>`, read as syntax rather than as
 * text?
 *
 * A body that merely mentions a helper in a comment or a string does not use
 * it, and declaring a requirement from one refuses a flow for a mount it never
 * needs. `f.run("echo f.gitlab")`, an agent prompt naming a helper, or a PR
 * title in a commit message were each enough to demand a GitLab mount.
 *
 * Dot access is read on the copy with comments AND strings blanked. Bracket
 * access needs the quoted key, so it is read on the comments-only copy and
 * then confirmed against the fully blanked one: the `f[` before the key must
 * have survived, which it does not inside a string.
 *
 * Mirrors Cloud's `flow-source-requirements.ts`, which already reads these
 * shapes this way; the two are the same contract seen from either side, and
 * the SDK being laxer meant a flow Cloud accepted could be refused locally.
 */
export function referencesHelper(
  root: string,
  namespace: string,
  code: string,
  withStrings: string,
): boolean {
  const dot = new RegExp(`(?:^|[^\\w$.])${root}\\s*\\.\\s*${namespace}\\b`, 'u');
  if (dot.test(code)) return true;
  const bracket = new RegExp(`(?:^|[^\\w$.])(${root}\\s*\\[\\s*)['"]${namespace}['"]\\s*\\]`, 'gu');
  for (const match of withStrings.matchAll(bracket)) {
    const prefix = match[1]!;
    const at = withStrings.indexOf(prefix, match.index!);
    if (at !== -1 && code.slice(at, at + prefix.length) === prefix) return true;
  }
  return false;
}

/**
 * Blank comments, and optionally strings, to spaces of the same length so
 * every index still lines up with the original source.
 */
export function blankKeepingLength(source: string, alsoStrings: boolean): string {
  let out = '';
  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];
    const isComment = ch === '/' && (next === '/' || next === '*');
    const isString = ch === '"' || ch === "'" || ch === '`';
    if (isComment || (alsoStrings && isString)) {
      const skipped = skipSpan(source, i);
      if (skipped === -1) return out + ' '.repeat(source.length - i);
      out += ' '.repeat(skipped - i);
      i = skipped;
      continue;
    }
    if (isString) {
      const skipped = skipSpan(source, i);
      if (skipped === -1) return out + source.slice(i);
      out += source.slice(i, skipped);
      i = skipped;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

/** Both copies a helper scan needs, from one walk of the source. */
export function helperScanCopies(body: string): { code: string; withStrings: string } {
  return { code: blankKeepingLength(body, true), withStrings: blankKeepingLength(body, false) };
}

/** Index just past the comment or string starting at `i`; `i` when none; -1 when unterminated. */
function skipSpan(text: string, i: number): number {
  const ch = text[i]!;
  const next = text[i + 1];
  if (ch === '/' && next === '/') { const end = text.indexOf('\n', i); return end === -1 ? text.length : end + 1; }
  if (ch === '/' && next === '*') { const end = text.indexOf('*/', i + 2); return end === -1 ? -1 : end + 2; }
  if (ch === '"' || ch === "'" || ch === '`') { const end = stringEnd(text, i); return end === -1 ? -1 : end + 1; }
  return i;
}

/** Index of the quote closing the string opening at `start` (template `${…}` skipped); -1 if unterminated. */
function stringEnd(text: string, start: number): number {
  const quote = text[start]!;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\') { i += 2; continue; }
    if (ch === quote) return i;
    if (quote === '`' && ch === '$' && text[i + 1] === '{') {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text[i] === '{') depth += 1;
        else if (text[i] === '}') depth -= 1;
        i += 1;
      }
      continue;
    }
    i += 1;
  }
  return -1;
}
