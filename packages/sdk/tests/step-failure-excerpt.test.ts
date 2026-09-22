import { describe, expect, it } from 'vitest';
import { EXCERPT_BYTES, MIN_EXCERPT_BYTES, formatStepExcerpt } from '../src/cli/step-excerpt.js';

/** Every marker this module prints is a line of its own, fenced by `…`. */
const MARKER = /^… .* …$/u;

function bytes(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/**
 * The bytes of the source that the excerpt actually shows.
 *
 * Only valid for a fixture of non-empty, newline-terminated, control-free
 * lines: then every content line of the output is a whole source line, worth
 * its own bytes plus the `\n` the split removed.
 */
function shownBytes(output: string): number {
  return output.split('\n')
    .filter((line, index, all) => !MARKER.test(line) && !(line === '' && index === all.length - 1))
    .reduce((sum, line) => sum + bytes(line) + 1, 0);
}

function elidedBytes(output: string): number {
  const stated = /… ([\d,]+) bytes elided/u.exec(output);
  expect(stated).not.toBeNull();
  return Number(stated![1]!.replaceAll(',', ''));
}

/** The reported case: a `not ok` early in a stream whose summary is last. */
function tapStream(cases: number, failing: readonly number[]): string {
  const lines = ['TAP version 13'];
  for (let index = 1; index <= cases; index++) {
    lines.push(failing.includes(index)
      ? `not ok ${index} - pty-exit: child reaped twice`
      : `ok ${index} - pty: a passing case with a realistically long name`);
  }
  lines.push(`1..${cases}`, `# tests ${cases}`, `# pass ${cases - failing.length}`, `# fail ${failing.length}`);
  return lines.join('\n') + '\n';
}

describe('formatStepExcerpt: what it keeps', () => {
  it('returns a stream that fits whole, and says nothing about elision', () => {
    const stream = tapStream(14, [5]);
    expect(bytes(stream)).toBeLessThan(EXCERPT_BYTES);
    const excerpt = formatStepExcerpt(stream);
    expect(excerpt).toBe(stream);
    expect(excerpt).not.toMatch(/elided/u);
  });

  it.each([
    ['an empty stream', ''],
    ['a single line with no newline', 'boom on stderr'],
    ['a stream of exactly the budget', 'x'.repeat(EXCERPT_BYTES - 1) + '\n'],
  ])('returns %s unchanged', (_label, stream) => {
    expect(formatStepExcerpt(stream)).toBe(stream);
  });

  it('elides one byte over the budget, and stays within it', () => {
    const excerpt = formatStepExcerpt('x'.repeat(EXCERPT_BYTES) + '\n');
    expect(excerpt).toMatch(/… [\d,]+ bytes elided …/u);
    expect(bytes(excerpt)).toBeLessThanOrEqual(EXCERPT_BYTES);
  });

  it('shows the failing case that the old last-1,024-bytes tail always cut', () => {
    // The reported case, scaled until it no longer fits and with the failing
    // case where a streaming runner leaves it — past the head, well before
    // the summary. Every byte of the last kilobyte of this stream is `ok` or
    // a total.
    const stream = tapStream(400, [200]);
    expect(bytes(stream)).toBeGreaterThan(EXCERPT_BYTES);
    expect(Buffer.from(stream, 'utf8').subarray(-1_024).toString('utf8'))
      .not.toContain('not ok 200');

    const excerpt = formatStepExcerpt(stream);
    expect(excerpt).toContain('not ok 200 - pty-exit: child reaped twice');
    // Head, marker and tail are all still there: the failing line arrives with
    // the run's opening and its summary, not instead of them.
    expect(excerpt).toContain('TAP version 13');
    expect(excerpt).toContain('# fail 1');
    expect(excerpt).toMatch(/… [\d,]+ bytes elided; 1 line matched a failure marker …/u);
    expect(excerpt).toContain('… end of elided region …');
    expect(bytes(excerpt)).toBeLessThanOrEqual(EXCERPT_BYTES);
  });

  it('keeps the head, which the tail-only render discarded outright', () => {
    const excerpt = formatStepExcerpt('discarded-prefix\n' + 'x\n'.repeat(4_000) + 'last error\n');
    expect(excerpt.startsWith('discarded-prefix\n')).toBe(true);
    expect(excerpt.endsWith('last error\n')).toBe(true);
  });

  it('accounts for every source byte: shown plus elided is the input', () => {
    const stream = tapStream(400, [200, 210]);
    const excerpt = formatStepExcerpt(stream);
    expect(shownBytes(excerpt) + elidedBytes(excerpt)).toBe(bytes(stream));
  });
});

describe('formatStepExcerpt: which lines it highlights', () => {
  it.each([
    ['Go per-test failures', '--- FAIL: TestFoo (0.00s)'],
    ['Jest failure headings', '  ● pty exits cleanly'],
    ['TAP', 'not ok 13 - pty-exit: child process exit is detected'],
    ['indented TAP subtests', '    not ok 2 - nested subtest'],
    ['pytest', 'FAILED tests/test_pty.py::test_exit - assert 1 == 0'],
    ['vitest file headers', ' FAIL  tests/pty-exit.test.ts > exit is detected'],
    ['vitest failure glyphs', '   × pty-exit: child process exit is detected'],
    ['cargo case results', 'test pty::exit::child_is_reaped ... FAILED'],
    ['cargo failure headings', '---- pty::exit::child_is_reaped stdout ----'],
    ['rust panics', "thread 'main' panicked at kernel/src/lib.rs:41:9:"],
    ['ANSI-coloured headers', '\u001b[31m FAIL \u001b[39m tests/pty-exit.test.ts'],
  ])('recognises a %s failure line from anywhere in the stream', (_runner, line) => {
    const filler = 'ok - a passing case with a realistically long name\n';
    const excerpt = formatStepExcerpt(filler.repeat(40) + line + '\n' + filler.repeat(120));
    // The ANSI case is matched on an escape-stripped view but rendered through
    // the display sanitiser, so compare on what survives sanitising.
    expect(excerpt).toContain(line.replaceAll(/[\p{Cc}\p{Cf}]/gu, '?'));
    expect(excerpt).toMatch(/1 line matched a failure marker/u);
  });

  it('gives an unrecognised format head and tail context without claiming a match', () => {
    const excerpt = formatStepExcerpt('first line\n' + 'noise\n'.repeat(2_000) + 'last line\n');
    expect(excerpt).toContain('first line');
    expect(excerpt).toContain('last line');
    expect(excerpt).toMatch(/^… [\d,]+ bytes elided …$/mu);
    expect(excerpt).not.toContain('failure marker');
    expect(excerpt).not.toContain('… end of elided region …');
  });

  it('does not repeat a failure that is already visible in the head or the tail', () => {
    const filler = 'ok - a passing case with a realistically long name\n';
    const stream = 'not ok 1 - in the head\n' + filler.repeat(200) + 'not ok 999 - in the tail\n';
    const excerpt = formatStepExcerpt(stream);
    expect(excerpt.split('not ok 1 - in the head')).toHaveLength(2);
    expect(excerpt.split('not ok 999 - in the tail')).toHaveLength(2);
    // Both are shown at their own position, so neither is reported as omitted.
    expect(excerpt).not.toContain('more matching lines');
  });

  it('treats two identical failing lines at two positions as two observations', () => {
    const filler = 'ok - a passing case with a realistically long name\n';
    const repeated = 'not ok 7 - the same name twice\n';
    const excerpt = formatStepExcerpt(
      filler.repeat(40) + repeated + filler.repeat(40) + repeated + filler.repeat(120));
    expect(excerpt.split(repeated.trimEnd())).toHaveLength(3);
    expect(excerpt).toMatch(/2 lines matched a failure marker/u);
  });

  it('caps the highlights at twenty lines and counts the rest', () => {
    const filler = 'ok - a passing case with a realistically long name\n';
    const failures = Array.from({ length: 50 }, (_, index) => `not ok ${index + 1} - middle failure\n`).join('');
    const excerpt = formatStepExcerpt(filler.repeat(40) + failures + filler.repeat(200));
    expect(excerpt.match(/^not ok /gmu)).toHaveLength(20);
    expect(excerpt).toMatch(/20 lines matched a failure marker/u);
    expect(excerpt).toContain('… +30 more matching lines …');
    expect(bytes(excerpt)).toBeLessThanOrEqual(EXCERPT_BYTES);
  });

  it('shows part of a failing line too long to fit, and says it was cut', () => {
    const filler = 'ok - a passing case with a realistically long name\n';
    const excerpt = formatStepExcerpt(
      filler.repeat(40) + 'not ok 5 - ' + 'D'.repeat(8_000) + '\n' + filler.repeat(120));
    expect(excerpt).toContain('not ok 5 - DDDD');
    expect(excerpt).toContain('… line truncated …');
    expect(bytes(excerpt)).toBeLessThanOrEqual(EXCERPT_BYTES);
  });

  it('names a failing case that the tail cut lands in the middle of', () => {
    // The tail is cut at a byte offset, not at a line boundary. A failing
    // line longer than the tail's share therefore keeps its uninformative
    // rest on screen while its marker and its name sit ahead of the cut —
    // the reported bug, one layout further in.
    const failure = 'not ok 5 - pty-exit: child reaped twice';
    const stream = 'ok - passing\n'.repeat(400) + failure + ' D'.repeat(2_000) + '\n# fail 1\n';
    const excerpt = formatStepExcerpt(stream);
    expect(excerpt).toContain(failure);
    expect(excerpt).toMatch(/… [\d,]+ bytes elided; 1 line matched a failure marker …/u);
    expect(excerpt).toContain('# fail 1');
    expect(bytes(excerpt)).toBeLessThanOrEqual(EXCERPT_BYTES);
  });

  it('keeps naming it wherever the cut lands, including exactly on its first byte', () => {
    // One byte of padding at a time slides the failing line across the tail
    // boundary, so the sweep covers every alignment there is: wholly in the
    // middle, cut anywhere inside, starting exactly at the tail, and wholly
    // inside the tail. It is named once in all of them — once, because a
    // line reported twice is two failures to the reader.
    const failure = 'not ok 5 - pty-exit: child reaped twice';
    for (const rest of [' D'.repeat(1_000), ' D'.repeat(2_000)]) {
      for (let pad = 0; pad < 200; pad++) {
        const stream = 'ok - passing\n'.repeat(400)
          + failure + rest + '\n' + 'x'.repeat(pad) + '\n# fail 1\n';
        const excerpt = formatStepExcerpt(stream);
        expect(excerpt.split(failure)).toHaveLength(2);
        expect(excerpt).toContain('# fail 1');
        expect(bytes(excerpt)).toBeLessThanOrEqual(EXCERPT_BYTES);
      }
    }
  });

  it('does not claim a truncation when the tail resumes the line at the cut', () => {
    // A kept prefix the tail picks up at the very byte it ended is one
    // unbroken run of source: the tail starts at the line instead, and the
    // excerpt shows the whole of it with no marker in the middle.
    const failing = 'not ok 5 - pty-exit: child reaped twice' + ' D'.repeat(1_000) + '\n';
    const excerpt = formatStepExcerpt('ok - passing\n'.repeat(400) + failing + '# fail 1\n');
    expect(excerpt).toContain(failing);
    expect(excerpt).not.toContain('… line truncated …');
    expect(excerpt.endsWith('# fail 1\n')).toBe(true);
    expect(bytes(excerpt)).toBeLessThanOrEqual(EXCERPT_BYTES);
  });

  it('counts a failing line the cut hides and the share could not fit', () => {
    // Thirty short matches spend the highlight share, so the long line the
    // tail cuts into gets no prefix of its own. What the tail shows of it
    // names nothing, so it is reported as omitted rather than as seen.
    const filler = 'ok - a passing case with a realistically long name\n';
    const middle = Array.from({ length: 30 },
      (_, index) => `not ok ${index + 1} - a middle failure with a realistically long name\n`).join('');
    const excerpt = formatStepExcerpt(filler.repeat(40) + middle + filler.repeat(20)
      + 'not ok 99 - crosses the tail cut' + ' D'.repeat(2_000) + '\n# fail 31\n');
    expect(excerpt).not.toContain('not ok 99 - crosses the tail cut');
    const shown = Number(/([\d,]+) lines matched a failure marker/u.exec(excerpt)![1]!.replaceAll(',', ''));
    const more = Number(/\+([\d,]+) more matching lines/u.exec(excerpt)![1]!.replaceAll(',', ''));
    expect(shown + more).toBe(31);
    expect(bytes(excerpt)).toBeLessThanOrEqual(EXCERPT_BYTES);
  });

  it('reports matches it had no room to show at all', () => {
    // One very long matching line consumes the highlight share; the rest of
    // the middle matches are counted rather than silently dropped.
    const long = 'not ok 1 - ' + 'D'.repeat(4_000) + '\n';
    const filler = 'ok - a passing case with a realistically long name\n';
    const excerpt = formatStepExcerpt(
      filler.repeat(40) + long + 'not ok 2 - short\nnot ok 3 - short\n' + filler.repeat(120));
    expect(excerpt).toContain('… +2 more matching lines …');
    expect(bytes(excerpt)).toBeLessThanOrEqual(EXCERPT_BYTES);
  });
});

describe('formatStepExcerpt: what it is safe to print', () => {
  it('never splits a multibyte character and never invents a replacement', () => {
    const excerpt = formatStepExcerpt('🙂'.repeat(2_000) + 'é');
    expect(excerpt).not.toContain('�');
    expect(bytes(excerpt)).toBeLessThanOrEqual(EXCERPT_BYTES);
  });

  it('keeps a replacement character the capture itself produced', () => {
    // The Rust capture decodes lossily and may hand over a U+FFFD of its own
    // at its 64 KiB boundary. That is data, not damage this module did.
    const excerpt = formatStepExcerpt('� head\n' + 'x\n'.repeat(4_000) + '� tail\n');
    expect(excerpt).toContain('� head');
    expect(excerpt).toContain('� tail');
  });

  it('replaces controls and bidi overrides on a short stream too, without growing it', () => {
    const stream = '\u001b[31mred\u009b0m‮overridden\u0000\r\n\tkept\n';
    const excerpt = formatStepExcerpt(stream);
    expect(excerpt).not.toMatch(/(?![\n\t])[\p{Cc}\p{Cf}]/u);
    expect(excerpt).toContain('\n\tkept\n');
    expect(bytes(excerpt)).toBeLessThanOrEqual(bytes(stream));
  });

  it('replaces controls in an elided stream and stays inside the budget', () => {
    const binary = Buffer.from([0, 0xff, 0x1b, 13, 8]).toString('utf8');
    const excerpt = formatStepExcerpt(binary.repeat(1_000) + '\u009b31m‮END\n\t');
    expect(excerpt).toMatch(/END\n\t$/u);
    expect(excerpt).not.toMatch(/[\x00-\x08\x0b-\x1f\x7f-\x9f\p{Cf}]/u);
    expect(bytes(excerpt)).toBeLessThanOrEqual(EXCERPT_BYTES);
  });

  it('handles CRLF, tabs and a final line with no newline', () => {
    const stream = 'first\r\n' + '\tindented\r\n'.repeat(1_000) + 'not ok 4 - crlf case\r\nno trailing newline';
    const excerpt = formatStepExcerpt(stream);
    expect(excerpt).toContain('first');
    expect(excerpt).toContain('no trailing newline');
    expect(excerpt).toContain('\tindented');
    expect(bytes(excerpt)).toBeLessThanOrEqual(EXCERPT_BYTES);
  });

  it('bounds a single enormous line with no newline at all', () => {
    const excerpt = formatStepExcerpt('A'.repeat(70_000));
    expect(bytes(excerpt)).toBeLessThanOrEqual(EXCERPT_BYTES);
    expect(excerpt).toMatch(/… [\d,]+ bytes elided …/u);
    expect(excerpt.startsWith('A')).toBe(true);
    expect(excerpt.endsWith('A')).toBe(true);
  });

  it.each([1_024, MIN_EXCERPT_BYTES, EXCERPT_BYTES, 8_192])('stays inside a %s byte budget', budget => {
    for (const stream of [
      tapStream(400, [200]),
      '🙂'.repeat(20_000),
      'A'.repeat(70_000),
      Array.from({ length: 300 }, (_, index) => `not ok ${index} - failure`).join('\n'),
    ]) {
      expect(bytes(formatStepExcerpt(stream, budget))).toBeLessThanOrEqual(budget);
    }
  });

  it.each([0, -1, 255, 1.5, Number.NaN])('refuses the unusable budget %s rather than eliding in silence', budget => {
    expect(() => formatStepExcerpt('x'.repeat(10_000), budget))
      .toThrow('step excerpt budget must be an integer of at least 256 bytes');
  });
});


describe('Jest section headings', () => {
  it('does not spend a failure slot on Console', () => {
    const filler = 'ok - passing case\n'.repeat(1000);
    const excerpt = formatStepExcerpt(filler + '  ● Console\n' + filler);
    expect(excerpt).not.toContain('● Console');
    expect(excerpt).not.toContain('failure marker');
  });
});


describe('capture-layer elision', () => {
  it.each([256, 1024, EXCERPT_BYTES])('preserves capture provenance within %s bytes', budget => {
    const marker = '… relayflow: 9000000 bytes elided at capture …';
    const stream = 'ok - passing\n'.repeat(1260) + marker + '\n' + 'ok - passing\n'.repeat(3600);
    const excerpt = formatStepExcerpt(stream, budget);
    expect(excerpt).toContain(marker);
    expect(excerpt).toMatch(/… [\d,]+ bytes elided …/u);
    expect(excerpt).not.toContain('failure marker');
    expect(bytes(excerpt)).toBeLessThanOrEqual(budget);
  });

  it('keeps capture provenance even after many failure matches', () => {
    const marker = '… relayflow: 9000000 bytes elided at capture …';
    const excerpt = formatStepExcerpt('ok\n'.repeat(2000) + 'not ok - failed\n'.repeat(100)
      + marker + '\n' + 'ok\n'.repeat(16000));
    expect(excerpt).toContain(marker);
    expect(bytes(excerpt)).toBeLessThanOrEqual(EXCERPT_BYTES);
  });
});
