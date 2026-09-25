// The cells every hosted-run page is built from.
//
// Moved out of `cli/cloud-read.ts` verbatim when the live views (`--watch`,
// `--follow`) needed the same formatting: the run list, the status page and
// the watched page must render a count, a cost and an instant identically, or
// a reader would have to learn which verb they were looking at first.
//
// Depends on nothing in `cli/` but `formatDuration`, so every other Cloud CLI
// module can import it without an import cycle.

import { formatDuration } from './status.js';

export function thousands(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}

export function dollars(value: number): string {
  return `$${value.toFixed(6).replace(/0+$/u, '').replace(/\.$/u, '')}`;
}

/** Agent- and flow-authored names cannot inject terminal control sequences. */
export function safe(text: string): string {
  return text.replace(/[\u0000-\u001F\u007F-\u009F]/gu, '?');
}

/**
 * Render a run's `error` as readable lines rather than one control-char smear.
 *
 * Cloud stores the runner's terminal output in this field, newlines and all, so
 * passing it through `safe()` alone turns a 200-line tail into a single line of
 * `?` separators. Long runs are dominated by lease renewals — one line every
 * 10s for the life of every agent step, differing only in the deadline — which
 * are worth counting, not reading.
 *
 * Collapsing is deliberately narrow: two adjacent lines merge only when they
 * are character-for-character identical once a trailing integer is masked. A
 * shared prefix is NOT line identity — runner lines put the step name, reason
 * or message after a long fixed prefix, so collapsing on a prefix would hide
 * distinct diagnostics behind a similarity count. The final line never
 * collapses into an earlier one, because that is where the failure is.
 */
const TRAILING_NUMBER = /\d+(?=\D{0,2}$)/u;

export function errorLines(text: string, indent: string): string[] {
  const raw = text.split(/\r\n|\r|\n/u).map((line) => line.trimEnd()).filter((line) => line !== '');
  if (raw.length === 0) return [];

  const key = (line: string): string => line.replace(TRAILING_NUMBER, '#');
  const collapsed: { line: string; count: number }[] = [];
  raw.forEach((line, index) => {
    const previous = collapsed.at(-1);
    const isLast = index === raw.length - 1;
    if (previous !== undefined && !isLast && key(previous.line) === key(line)) previous.count += 1;
    else collapsed.push({ line, count: 1 });
  });

  const rendered = collapsed.map(({ line, count }) =>
    count === 1 ? safe(line) : `${safe(line)}  (${count} times, differing only in a number)`);

  const HEAD = 2;
  const TAIL = 12;
  if (rendered.length <= HEAD + TAIL + 1) return rendered.map((line) => `${indent}${line}`);
  const elided = rendered.length - HEAD - TAIL;
  return [
    ...rendered.slice(0, HEAD),
    `… ${elided} more line${elided === 1 ? '' : 's'} (full text: --json)`,
    ...rendered.slice(-TAIL),
  ].map((line) => `${indent}${line}`);
}

/** ISO-8601 to the second: a list column, not a timestamp to do arithmetic on. */
export function instant(value: string | null): string {
  if (value === null) return 'unknown';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString().replace(/\.\d{3}Z$/u, 'Z') : 'unknown';
}

export function ago(value: string | null, now: number): string {
  if (value === null) return 'unknown';
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? `${formatDuration(now - parsed)} ago` : 'unknown';
}
