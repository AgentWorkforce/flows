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

/**
 * Index of the `/` closing the regular-expression literal opening at `start`,
 * with `\` escapes and `[…]` classes honored; -1 when no literal ends there.
 *
 * A regex literal cannot span a line, so an unclosed one is not a literal at
 * all — it is a division the caller should read as code, which is why this
 * stops at the first newline rather than running to the end of the body.
 */
function regexEnd(text: string, start: number): number {
  let inClass = false;
  let i = start + 1;
  while (i < text.length) {
    const ch = text[i]!;
    if (ch === '\n') return -1;
    if (ch === '\\') { if (i + 1 >= text.length || text[i + 1] === '\n') return -1; i += 2; continue; }
    if (inClass) { if (ch === ']') inClass = false; }
    else if (ch === '[') inClass = true;
    else if (ch === '/') return i;
    i += 1;
  }
  return -1;
}

/** Keywords a regex literal may directly follow; after any other word it is division. */
const regexKeywords = new Set(['await', 'case', 'delete', 'do', 'else', 'in', 'instanceof',
  'new', 'of', 'return', 'throw', 'typeof', 'void', 'yield']);

/**
 * Whether a `/` at the end of the code-only prefix `before` opens a regex
 * literal rather than dividing.
 *
 * Deciding this exactly needs a parser. Where it cannot be decided — after `)`
 * or `}`, which end an operand and a control-flow head alike — this answers
 * "regex", because the two mistakes are not symmetric: reading a division as a
 * literal only blanks text, which can withdraw a refusal and leave the runtime
 * guard to make it, while reading a literal as code invents a refusal for a
 * flow that never touched the helper.
 */
function opensRegex(before: string): boolean {
  const word = before.match(/[\w$]+[^\S\n]*$/u);
  if (word !== null) return regexKeywords.has(word[0].trimEnd());
  return !/\][^\S\n]*$/u.test(before);
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
 * The body with every comment, string/template and regular-expression literal
 * replaced by blanks of the same length, so a pattern may be matched against
 * code alone at unchanged offsets. Blanking only ever REMOVES text: a match
 * found here was in the source, which is why the result can refuse a flow.
 * What it hides — an access built inside a template interpolation, say — falls
 * through to the runtime guard rather than becoming a refusal of something the
 * author did not write.
 *
 * A regex literal is data too: `/f.gitlab.issues/.test(line)` inspects text
 * and reaches no helper, so its contents must not read as a member access.
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
    if (text[i] === '/' && opensRegex(out)) {
      const end = regexEnd(text, i);
      if (end !== -1) { out += blank(text.slice(i, end + 1)); i = end + 1; continue; }
    }
    out += text[i]!;
    i += 1;
  }
  return out;
}

/**
 * Whether `name` is bound again in `code` after `from`, so an `name.x` later
 * in the body need not be the flow context at all.
 *
 * `code` is a `codeOnly` result and `from` is the end of the body's own
 * parameter declaration, which must not count as a rebinding of itself.
 * Renaming a local callback parameter cannot decide whether a flow is
 * admitted, so a caller that finds a rebinding declines to judge the body
 * statically and leaves it to the runtime guard. This over-declines — an
 * inner binding that never shadows the access is still a rebinding here —
 * which loses a static refusal rather than inventing one.
 */
export function rebindsIdentifier(code: string, name: string, from: number): boolean {
  const after = code.slice(from);
  const word = `(?:^|[^\\w$.])${name}`;
  // A single-parameter arrow, a declaration, or an assignment over the parameter.
  if (new RegExp(`${word}\\s*=>`, 'u').test(after)) return true;
  if (new RegExp(`(?:^|[^\\w$.])(?:const|let|var|function|class)\\s+${name}(?:[^\\w$]|$)`, 'u').test(code)) return true;
  if (new RegExp(`${word}\\s*=(?![=>])`, 'u').test(after)) return true;
  const bound = new RegExp(`${word}(?:[^\\w$]|$)`, 'u');
  for (const parameters of parameterLists(code, from)) if (bound.test(parameters)) return true;
  // A destructured declaration binds the name without writing it as the
  // declaration's own identifier: `const { f } = …` shadows `f` exactly as
  // `const f = …` does, so the simple-declaration rule above cannot see it.
  for (const declaration of code.matchAll(/(?:^|[^\w$.])(?:const|let|var)\s*[[{]/gu)) {
    const open = declaration.index + declaration[0].length - 1;
    const close = matchingClose(code, open);
    if (close !== -1 && bound.test(code.slice(open + 1, close))) return true;
  }
  // An object or class method binds its parameters the way `function` does,
  // but carries no keyword for the parameterLists walker to key on:
  // `read(f) { … }`. The `(` must open a parameter list — i.e. close directly
  // ahead of a `{` — and the head must not be a control keyword (`if (f) {`
  // binds nothing). Anything else `ident(…){` can only be a method.
  for (const head of code.matchAll(/(?:^|[^\w$.])([A-Za-z_$][\w$]*)\s*\(/gu)) {
    if (CONTROL_HEADS.has(head[1]!)) continue;
    const open = head.index + head[0].length - 1;
    if (open < from) continue;
    const close = matchingClose(code, open);
    if (close === -1 || !/^\s*\{/.test(code.slice(close + 1))) continue;
    if (bound.test(code.slice(open + 1, close))) return true;
  }
  return false;
}

/** Keywords whose `name (…) {` is a control clause, not a parameter list. */
const CONTROL_HEADS: ReadonlySet<string> = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'catch', 'with', 'try', 'finally',
  'function', 'return', 'throw', 'typeof', 'new', 'delete', 'void', 'in', 'of',
  'instanceof', 'await', 'yield', 'case', 'const', 'let', 'var', 'class',
  'extends', 'import', 'export', 'default',
]);

/** The text inside each `(…)` that binds names after `from`: arrow, `function` and `catch` parameters. */
function* parameterLists(code: string, from: number): Generator<string> {
  for (const arrow of code.matchAll(/\)\s*=>/gu)) {
    const open = matchingOpen(code, arrow.index);
    if (open >= from) yield code.slice(open + 1, arrow.index);
  }
  for (const head of code.matchAll(/(?:^|[^\w$.])(?:function(?:\s+[\w$]+)?|catch)\s*\(/gu)) {
    const open = head.index + head[0].length - 1;
    const close = open >= from ? matchingClose(code, open) : -1;
    if (close !== -1) yield code.slice(open + 1, close);
  }
}

/** Index of the `(` opening the group closed at `close`; -1 if unbalanced. `code` is comment- and literal-free. */
function matchingOpen(code: string, close: number): number {
  let depth = 0;
  for (let i = close; i >= 0; i -= 1) {
    if (code[i] === ')') depth += 1;
    else if (code[i] === '(' && (depth -= 1) === 0) return i;
  }
  return -1;
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
