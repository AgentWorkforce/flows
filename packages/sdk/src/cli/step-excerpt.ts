/**
 * One captured stream, cut to something a terminal can print WITHOUT throwing
 * away the line that says what failed.
 *
 * The render this replaces kept the last 1,024 bytes. For any runner that
 * streams results and prints its summary last — TAP (`node --test`), cargo,
 * vitest, pytest — the last kilobyte is by construction the totals and the
 * final few passing cases, so the one `not ok` was always the part that got
 * cut. A report that proves a failure happened and withholds which one costs
 * the reader a local re-run, which is the loop the gate exists to avoid.
 *
 * So the excerpt is three disjoint ranges of the same source, in source order:
 * a head, the lines in the elided middle that look like a failing case, and a
 * tail. The elision is stated in band, in bytes, so the reader is never left
 * guessing whether what they are looking at is all of it.
 *
 * What this can and cannot promise:
 *
 * - It selects from the field the journal carried, which for a deterministic
 *   step is the last 64 KiB the kernel captured (`OUTPUT_TAIL_BYTES`,
 *   relayflowd/src/exec_det.rs). A failure printed before that window is not
 *   here to be found, and no marker can say so — hence `captured excerpt`
 *   rather than a claim about the command's whole output.
 * - The absence of an elision marker means the supplied field fit whole. It
 *   does not mean the command printed nothing more.
 * - The markers are hints, not a parser. They find the common runners' failing
 *   lines; ordinary prose can match one, and an unknown format matches none
 *   and still gets head-and-tail context.
 */

/** Default excerpt budget, in UTF-8 bytes, for one captured stream. */
export const EXCERPT_BYTES = 4_096;

/**
 * Below this there is no room to both elide and say so, and an excerpt that
 * silently drops the claim it makes about itself is the bug being fixed. The
 * budget is a constant of this module, not configuration, so a caller that
 * asks for less has made a programming error and is told at the call.
 */
export const MIN_EXCERPT_BYTES = 256;

/** How many matched lines the elided middle may contribute. */
const MAX_HIGHLIGHT_LINES = 20;

/** A highlight cut short is only worth showing if some of the line survives. */
const MIN_HIGHLIGHT_BYTES = 24;

/** Newlines this module inserts between ranges and markers. */
const SEPARATOR_RESERVE = 16;

const END_MARKER = '… end of elided region …';
const TRUNCATED_MARKER = '… line truncated …';

/**
 * Lines that name a failing case, for the runners this repo actually runs.
 *
 * Each is anchored after optional indentation (nested TAP indents its
 * subtests) and is matched against a comparison view of the line with
 * terminal escapes removed, so a coloured `FAIL` header still matches. They
 * are constants rather than user input, which is why `RegExp` is correct
 * here; a spec-supplied pattern would be untrusted and would have to go
 * through `re2js`.
 */
const FAILURE_MARKERS: readonly RegExp[] = [
  /^\s*not ok\b/u, // TAP: node --test, prove
  /^\s*FAILED\b/u, // pytest short test summary: `FAILED tests/x.py::y - ...`
  /^\s*FAIL\b/u, // vitest / jest file header: `FAIL src/x.test.ts`
  /^\s*[✖✗×]\s/u, // vitest / jest failure glyph
  /\.\.\.\s*FAILED\b/u, // cargo: `test pty::exit ... FAILED`
  /^\s*---- .* ----\s*$/u, // cargo: `---- pty::exit stdout ----`
  /\bpanicked at\b/u, // rust panic
];

interface Range { start: number; end: number }

/**
 * Cut `value` to at most `budget` UTF-8 bytes, markers included.
 *
 * A stream that already fits is returned whole (sanitised) with no marker. One
 * that does not keeps a head of whole lines, up to `MAX_HIGHLIGHT_LINES`
 * matched lines from the elided middle, and a tail that fills what is left.
 * Every cut is at a code-point boundary, so slicing never invents a U+FFFD.
 */
export function formatStepExcerpt(value: string, budget: number = EXCERPT_BYTES): string {
  if (!Number.isSafeInteger(budget) || budget < MIN_EXCERPT_BYTES) {
    throw new Error(`step excerpt budget must be an integer of at least ${MIN_EXCERPT_BYTES} bytes`);
  }
  const source = Buffer.from(value, 'utf8');
  // Sanitised from the original string, not from the round trip: a lone
  // surrogate the wire delivered is the caller's to keep, and re-encoding it
  // would be this module inventing a replacement character.
  if (source.length <= budget) return sanitise(value);

  const lines = lineRanges(source);
  const matches = lines.filter(isFailureLine(source));
  // Content space is what is left after the markers can be afforded at their
  // widest, so the excerpt can always state its own elision.
  const content = Math.max(0, budget - markerReserve(source.length, matches.length));
  const tailShare = Math.floor(content / 2);
  const headShare = Math.floor(content / 4);
  const highlightShare = content - tailShare - headShare;

  const head = headRange(source, lines, headShare);
  // Provisional tail, which with the head defines the middle the highlights
  // are drawn from.
  const highlights = selectHighlights(source, matches, highlightShare,
    head.end, tailRange(source, tailShare, head.end).start);

  // Every byte the head and the highlights did not need goes to the tail,
  // which is where a runner puts the summary. The tail may not cross the last
  // highlight, so the ranges stay disjoint and in source order.
  const spare = headShare - size(head)
    + highlightShare - highlights.reduce((sum, highlight) => sum + size(highlight.range), 0);
  const tail = tailRange(source, tailShare + spare, highlights.at(-1)?.range.end ?? head.end);

  const selected = [head, ...highlights.map(highlight => highlight.range), tail]
    .filter(range => size(range) > 0);
  const elided = source.length - selected.reduce((sum, range) => sum + size(range), 0);
  // Positional, not textual: two identical failing lines at two positions are
  // two observations, and one of them may be visible while the other is not.
  // A line shown in part — a truncated highlight, or one the tail starts in
  // the middle of — was not omitted, so only a line with nothing on screen is
  // counted here.
  const omitted = matches.filter(match =>
    !selected.some(range => match.start < range.end && match.end > range.start)).length;

  const parts: string[] = [];
  const terminated = (chunk: string): string => chunk.endsWith('\n') ? chunk : `${chunk}\n`;
  if (size(head) > 0) parts.push(terminated(text(source, head)));
  parts.push(`${openMarker(elided, highlights.length, omitted)}\n`);
  for (const highlight of highlights) {
    parts.push(terminated(text(source, highlight.range) + (highlight.truncated ? ` ${TRUNCATED_MARKER}` : '')));
  }
  if (highlights.length > 0) {
    if (omitted > 0) parts.push(`${moreMarker(omitted)}\n`);
    parts.push(`${END_MARKER}\n`);
  }
  if (size(tail) > 0) parts.push(text(source, tail));
  // Sanitising replaces, never expands, so it cannot push the result over the
  // budget; the clamp is where the byte bound is enforced, for every path.
  return clampBytes(sanitise(parts.join('')), budget);
}

/**
 * `N bytes elided` counts raw source bytes represented by no selected range,
 * including the omitted portion of a line shown only in part. Source bytes
 * shown plus source bytes elided is the input, exactly; the markers this
 * module inserts are not source bytes, and sanitising can shrink what is
 * displayed without changing what was selected.
 */
function openMarker(elided: number, shown: number, omitted: number): string {
  const matched = shown > 0
    ? `; ${plural(shown, 'line')} matched a failure marker`
    : omitted > 0 ? `; ${plural(omitted, 'line')} matched a failure marker, none shown` : '';
  return `… ${group(elided)} bytes elided${matched} …`;
}

function moreMarker(omitted: number): string {
  return `… +${group(omitted)} more matching ${omitted === 1 ? 'line' : 'lines'} …`;
}

/** Every marker at its widest, so content space can be assigned once. */
function markerReserve(sourceBytes: number, matches: number): number {
  const open = Math.max(
    byteLength(openMarker(sourceBytes, matches, matches)),
    byteLength(openMarker(sourceBytes, 0, matches)),
    byteLength(openMarker(sourceBytes, 0, 0)),
  );
  const highlighted = matches === 0 ? 0
    : byteLength(moreMarker(matches)) + byteLength(END_MARKER) + byteLength(TRUNCATED_MARKER) + 1;
  return open + highlighted + SEPARATOR_RESERVE;
}

/**
 * Matched lines from the middle, in source order, bounded by both the line cap
 * and the byte share. A whole line is preferred; when the first candidate does
 * not fit at all, a code-point-safe prefix of it is shown under a truncation
 * marker, because a cut failing line still names the failing case and no
 * highlight at all does not.
 */
function selectHighlights(
  source: Buffer, matches: readonly Range[], share: number, from: number, to: number,
): Array<{ range: Range; truncated: boolean }> {
  const selected: Array<{ range: Range; truncated: boolean }> = [];
  let remaining = share;
  for (const match of matches) {
    // Already visible in the head or the tail, or straddling one of them: a
    // line is reported once, at its own position.
    if (match.start < from || match.end > to) continue;
    if (selected.length >= MAX_HIGHLIGHT_LINES) break;
    if (size(match) <= remaining) {
      selected.push({ range: match, truncated: false });
      remaining -= size(match);
      continue;
    }
    if (selected.length === 0 && remaining >= MIN_HIGHLIGHT_BYTES) {
      const end = floorBoundary(source, match.start + remaining);
      if (end > match.start) selected.push({ range: { start: match.start, end }, truncated: true });
    }
    break;
  }
  return selected;
}

/**
 * Whole lines from the start, or a bounded prefix when the first line alone is
 * longer than the share — a long first line must not consume the excerpt.
 * Whatever whole lines leave unspent is returned to the tail by the caller.
 */
function headRange(source: Buffer, lines: readonly Range[], limit: number): Range {
  let end = 0;
  for (const line of lines) {
    if (line.end > limit) break;
    end = line.end;
  }
  return { start: 0, end: end === 0 ? floorBoundary(source, limit) : end };
}

/**
 * The last `limit` bytes, cut at a code-point boundary and never crossing
 * `stop` (the end of the head or of the last highlight).
 *
 * Unlike the head, the tail fills its share rather than stopping at a line
 * boundary. A stream can be one enormous line followed by a one-byte last
 * line; taking whole lines only would spend one byte of a two-kilobyte share
 * and drop the summary that the old last-1,024-bytes render always kept.
 */
function tailRange(source: Buffer, limit: number, stop: number): Range {
  return { start: Math.max(ceilBoundary(source, source.length - limit), stop), end: source.length };
}

function isFailureLine(source: Buffer): (line: Range) => boolean {
  return line => {
    const comparable = comparableLine(text(source, line));
    return FAILURE_MARKERS.some(marker => marker.test(comparable));
  };
}

/**
 * The view a marker is matched against: terminal escape sequences and control
 * characters removed so a coloured `not ok` or `FAIL` header still matches.
 * This never touches what is rendered — journal data is not mutated, and the
 * display sanitiser is a separate, later step.
 */
function comparableLine(line: string): string {
  return line
    .replace(/\u001b\[[0-9;:?]*[ -/]*[@-~]|\u001b[@-Z\\-_]|\u009b[0-9;:?]*[ -/]*[@-~]/gu, '')
    .replace(/[\p{Cc}\p{Cf}]/gu, character => character === '\t' ? ' ' : '');
}

/** Line ranges over the raw bytes; each end includes its own `\n` when it has one. */
function lineRanges(source: Buffer): Range[] {
  const ranges: Range[] = [];
  let start = 0;
  for (let index = 0; index < source.length; index++) {
    if (source[index] === 0x0a) {
      ranges.push({ start, end: index + 1 });
      start = index + 1;
    }
  }
  if (start < source.length) ranges.push({ start, end: source.length });
  return ranges;
}

/**
 * Preserve tabs and newlines; replace binary controls (including ESC and CR),
 * C1 controls and Unicode formatting controls without growing the excerpt.
 * Applied on every path, short inputs included: a control sequence in a
 * two-line stderr is as able to rewrite the terminal as one in a long stream.
 */
function sanitise(value: string): string {
  return value.replace(/[\p{Cc}\p{Cf}]/gu, character =>
    character === '\n' || character === '\t' ? character : '?');
}

function clampBytes(value: string, budget: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= budget) return value;
  return bytes.subarray(0, floorBoundary(bytes, budget)).toString('utf8');
}

function text(source: Buffer, range: Range): string {
  return source.subarray(range.start, range.end).toString('utf8');
}

function size(range: Range): number {
  return range.end - range.start;
}

function isBoundary(source: Buffer, index: number): boolean {
  return index >= source.length || (source[index]! & 0xc0) !== 0x80;
}

function floorBoundary(source: Buffer, index: number): number {
  let at = Math.max(0, Math.min(index, source.length));
  while (at > 0 && !isBoundary(source, at)) at -= 1;
  return at;
}

function ceilBoundary(source: Buffer, index: number): number {
  let at = Math.max(0, Math.min(index, source.length));
  while (at < source.length && !isBoundary(source, at)) at += 1;
  return at;
}

function byteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

function plural(count: number, noun: string): string {
  return `${group(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/** Locale-independent digit grouping: the same excerpt everywhere it is read. */
function group(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ',');
}
