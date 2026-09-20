/**
 * The bounded source scanner every static body inspection steps through.
 *
 * A flow body is read from `Function.prototype.toString` — never executed — so
 * the declarations preflight judges are read out of text. Text is not syntax:
 * a `to:`, a bracket or an `f.gitlab.issues` inside a comment or a string is
 * not a declaration, and reading it as one refuses a correct flow. These
 * walkers skip comments, strings and templates so that cannot happen.
 *
 * This is deliberately not a parser. Template interpolations and computed
 * names are opaque here; those reach the runtime guard instead.
 */

/**
 * Skip the comment or string starting at `i`, returning the index just past
 * it; `i` itself when nothing skippable starts there; -1 when unterminated.
 */
export function skipCommentOrString(text: string, i: number): number {
  const ch = text[i]!;
  const next = text[i + 1];
  if (ch === '/' && next === '/') { const end = text.indexOf('\n', i); return end === -1 ? text.length : end + 1; }
  if (ch === '/' && next === '*') { const end = text.indexOf('*/', i + 2); return end === -1 ? -1 : end + 2; }
  if (ch === '"' || ch === "'" || ch === '`') { const end = stringEnd(text, i); return end === -1 ? -1 : end + 1; }
  return i;
}

/** Index of the `)`/`}`/`]` closing the bracket at `open`, skipping strings, templates and comments; -1 if unbalanced. */
export function matchingClose(text: string, open: number): number {
  const pairs: Record<string, string> = { '(': ')', '{': '}', '[': ']' };
  const stack: string[] = [pairs[text[open]!]!];
  let i = open + 1;
  while (i < text.length && stack.length > 0) {
    const skipped = skipCommentOrString(text, i);
    if (skipped === -1) return -1;
    if (skipped !== i) { i = skipped; continue; }
    const ch = text[i]!;
    if (ch in pairs) stack.push(pairs[ch]!);
    else if (ch === ')' || ch === '}' || ch === ']') { if (stack.pop() !== ch) return -1; }
    i += 1;
  }
  return stack.length === 0 ? i - 1 : -1;
}

/** Index of the quote closing the string opening at `start` (template `${…}` skipped); -1 if unterminated. */
export function stringEnd(text: string, start: number): number {
  const quote = text[start]!;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\\') { i += 2; continue; }
    if (ch === quote) return i;
    if (quote === '`' && ch === '$' && text[i + 1] === '{') {
      const end = matchingClose(text, i + 1);
      if (end === -1) return -1;
      i = end + 1;
      continue;
    }
    i += 1;
  }
  return -1;
}

/**
 * The body with every comment and string/template replaced by blanks of the
 * same length, so a pattern may be matched against code alone at unchanged
 * offsets. Blanking only ever REMOVES text: a match found here was in the
 * source, which is why the result can refuse a flow. What it hides — an access
 * built inside a template interpolation, say — falls through to the runtime
 * guard rather than becoming a refusal of something the author did not write.
 *
 * One literal is kept, because it is syntax rather than data: an
 * identifier-shaped quoted string between `[` and `]` is the property name of
 * a member access. Blanking it would hide `f['gitlab']['issues']`, which is
 * the same access as `f.gitlab.issues` and has to read the same way here.
 */
export function codeOnly(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    const skipped = skipCommentOrString(text, i);
    // Unterminated: the remainder is not code this scanner can judge.
    if (skipped === -1) return out + blank(text.slice(i));
    if (skipped !== i) {
      const span = text.slice(i, skipped);
      out += isPropertyKey(text, i, skipped, out) ? span : blank(span);
      i = skipped;
      continue;
    }
    out += text[i]!;
    i += 1;
  }
  return out;
}

/**
 * Whether `text[start…end)` is a quoted property name inside `[` … `]`.
 * `before` is the code-only prefix, so a `[` that is itself inside a comment
 * or a string cannot put a literal in key position.
 */
function isPropertyKey(text: string, start: number, end: number, before: string): boolean {
  const quote = text[start]!;
  if (quote !== '"' && quote !== "'") return false;
  if (!/^[\w$]+$/u.test(text.slice(start + 1, end - 1))) return false;
  return /\[[^\S\n]*$/u.test(before) && /^[^\S\n]*\]/u.test(text.slice(end));
}

const blank = (text: string) => text.replace(/[^\n]/gu, ' ');
