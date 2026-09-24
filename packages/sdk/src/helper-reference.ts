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
 * Both scan copies, from one lexical walk, with every index preserved.
 *
 * `code` blanks comments, string literals and regex literals; `withStrings`
 * blanks comments and regex literals but keeps string contents, because
 * `f["gitlab"]` hides its namespace inside a string.
 *
 * Two shapes have to be lexed rather than skipped wholesale, and getting
 * either wrong produces a FALSE NEGATIVE — a flow that really uses a helper
 * deploying without its mount and failing at runtime, which is worse than the
 * false refusal this scan exists to remove:
 *
 *   - A template literal is not one span. Its quasis are text, but each
 *     `${...}` is live code that can call a helper, so interpolations are
 *     walked as code (nested templates, strings and comments included).
 *   - A regex literal is not code. `/f.gitlab/` is a mention, not a use, and
 *     a quote inside one (`/'/`) would otherwise open a phantom string and
 *     blank the entire rest of the body.
 */
export function scanHelperSource(source: string): { code: string; withStrings: string } {
  const code: string[] = [];
  const withStrings: string[] = [];
  const push = (text: string, blankCode: boolean, blankStrings: boolean): void => {
    code.push(blankCode ? ' '.repeat(text.length) : text);
    withStrings.push(blankStrings ? ' '.repeat(text.length) : text);
  };

  let i = 0;
  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1];

    if (ch === '/' && next === '/') {
      const end = source.indexOf('\n', i);
      const stop = end === -1 ? source.length : end;
      push(source.slice(i, stop), true, true);
      i = stop;
      continue;
    }
    if (ch === '/' && next === '*') {
      const end = source.indexOf('*/', i + 2);
      const stop = end === -1 ? source.length : end + 2;
      push(source.slice(i, stop), true, true);
      i = stop;
      continue;
    }
    if (ch === '/' && regexCanStartAt(source, i)) {
      const stop = regexEnd(source, i);
      if (stop !== -1) {
        // Keep the delimiters so the text still lexes as an expression; blank
        // the body in BOTH copies — a helper named in a pattern is not used.
        push('/', false, false);
        push(source.slice(i + 1, stop - 1), true, true);
        push(source.slice(stop - 1, stop), false, false);
        i = stop;
        continue;
      }
    }
    if (ch === '"' || ch === "'") {
      const stop = quotedEnd(source, i);
      if (stop === -1) { push(source.slice(i), true, false); break; }
      push(source.slice(i, stop), true, false);
      i = stop;
      continue;
    }
    if (ch === '`') {
      i = walkTemplate(source, i, push);
      continue;
    }
    push(ch, false, false);
    i += 1;
  }
  return { code: code.join(''), withStrings: withStrings.join('') };
}

/**
 * Walk a template from its opening backtick, blanking quasis and recursing
 * into `${...}` so helper calls inside an interpolation stay visible.
 * Returns the index just past the closing backtick.
 */
function walkTemplate(
  source: string,
  start: number,
  push: (text: string, blankCode: boolean, blankStrings: boolean) => void,
): number {
  push('`', false, false);
  let i = start + 1;
  let quasi = i;
  const flushQuasi = (stop: number): void => {
    if (stop > quasi) push(source.slice(quasi, stop), true, false);
  };
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') {
      flushQuasi(i);
      push('`', false, false);
      return i + 1;
    }
    if (ch === '$' && source[i + 1] === '{') {
      flushQuasi(i);
      const close = expressionEnd(source, i + 2);
      const stop = close === -1 ? source.length : close;
      push('${', false, false);
      const inner = scanHelperSource(source.slice(i + 2, stop));
      push('', false, false);
      // Push the inner copies directly so both stay index-aligned.
      pushPrescanned(push, inner, source.slice(i + 2, stop));
      if (close !== -1) push('}', false, false);
      i = close === -1 ? source.length : close + 1;
      quasi = i;
      continue;
    }
    i += 1;
  }
  flushQuasi(i);
  return i;
}

/** Emit an already-scanned span, keeping `code` and `withStrings` distinct. */
function pushPrescanned(
  push: (text: string, blankCode: boolean, blankStrings: boolean) => void,
  inner: { code: string; withStrings: string },
  raw: string,
): void {
  // The two copies differ, so they cannot go through the shared `push`.
  // Emit character-wise: identical characters keep their value, and a
  // character blanked in one copy is emitted blanked there only.
  for (let k = 0; k < raw.length; k += 1) {
    const c = inner.code[k] ?? ' ';
    const w = inner.withStrings[k] ?? ' ';
    if (c === w) push(c, false, false);
    else push(c === ' ' ? w : c, c === ' ', w === ' ');
  }
}

/** Index just past the `}` closing an interpolation opened at `start`; -1 if unterminated. */
function expressionEnd(source: string, start: number): number {
  let depth = 1;
  let i = start;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '"' || ch === "'") { const stop = quotedEnd(source, i); i = stop === -1 ? source.length : stop; continue; }
    if (ch === '`') { i = skipTemplate(source, i); continue; }
    if (ch === '/' && source[i + 1] === '/') { const end = source.indexOf('\n', i); i = end === -1 ? source.length : end; continue; }
    if (ch === '/' && source[i + 1] === '*') { const end = source.indexOf('*/', i + 2); i = end === -1 ? source.length : end + 2; continue; }
    if (ch === '/' && regexCanStartAt(source, i)) { const stop = regexEnd(source, i); if (stop !== -1) { i = stop; continue; } }
    if (ch === '{') depth += 1;
    else if (ch === '}') { depth -= 1; if (depth === 0) return i; }
    i += 1;
  }
  return -1;
}

/** Index just past the template closing backtick. */
function skipTemplate(source: string, start: number): number {
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') { i += 2; continue; }
    if (ch === '`') return i + 1;
    if (ch === '$' && source[i + 1] === '{') {
      const close = expressionEnd(source, i + 2);
      i = close === -1 ? source.length : close + 1;
      continue;
    }
    i += 1;
  }
  return i;
}

/** Index just past the quote closing a '…' or "…" opened at `start`; -1 if unterminated. */
function quotedEnd(source: string, start: number): number {
  const quote = source[start]!;
  let i = start + 1;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') { i += 2; continue; }
    if (ch === '\n') return -1;
    if (ch === quote) return i + 1;
    i += 1;
  }
  return -1;
}

/**
 * Whether the `/` at `i` opens a regex rather than dividing.
 *
 * Deliberately conservative: only after a character that cannot END an
 * expression. Reading a division as a regex would blank real code and hide a
 * helper (a false negative); reading a regex as division only risks the
 * milder false refusal, so ambiguity resolves toward "not a regex".
 */
function regexCanStartAt(source: string, i: number): boolean {
  let k = i - 1;
  while (k >= 0 && /\s/u.test(source[k]!)) k -= 1;
  if (k < 0) return true;
  const prev = source[k]!;
  if (/[)\]}]/u.test(prev)) return false;
  if (/[\w$]/u.test(prev)) {
    let start = k;
    while (start >= 0 && /[\w$]/u.test(source[start]!)) start -= 1;
    const word = source.slice(start + 1, k + 1);
    return ['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'yield', 'await', 'void', 'delete', 'instanceof', 'new'].includes(word);
  }
  return true;
}

/** Index just past the closing `/` (and flags) of a regex opened at `start`; -1 if not a regex. */
function regexEnd(source: string, start: number): number {
  let i = start + 1;
  let inClass = false;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') { i += 2; continue; }
    if (ch === '\n') return -1;
    if (inClass) { if (ch === ']') inClass = false; }
    else if (ch === '[') inClass = true;
    else if (ch === '/') {
      i += 1;
      while (i < source.length && /[a-z]/u.test(source[i]!)) i += 1;
      return i;
    }
    i += 1;
  }
  return -1;
}

/** Both copies a helper scan needs, from one walk of the source. */
export function helperScanCopies(body: string): { code: string; withStrings: string } {
  return scanHelperSource(body);
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
