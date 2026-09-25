/**
 * POSIX shell quoting for the invocations diagnostics tell people to run.
 *
 * Dependency-free on purpose: every module that renders a command reaches for
 * this, and two of them (`cli/run.ts` and `authored-human.ts`) already import
 * each other's neighbours. A copy per call site is how one of them ends up
 * emitting a path with a space in it unquoted.
 */

/** `value` as a single word, quoted only when it would not survive a shell. */
export function shellWord(value: string): string {
  return /^[A-Za-z0-9_./=:@%+,-]+$/.test(value) ? value : shellQuote(value);
}

/**
 * `value` as a single-quoted word, always.
 *
 * Used where the rendered argument is arbitrary author data — a flow path or a
 * JSON `--input` — and the quotes are worth keeping even when unnecessary, so
 * the command reads the same for `a.flow.ts` and for `my flows/a.flow.ts`.
 */
export function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
