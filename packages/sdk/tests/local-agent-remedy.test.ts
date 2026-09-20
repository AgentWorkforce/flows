import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

import { authoredInput, authoredWorkerRemedy, localAgentRemedy } from '../src/cli/local-agent-remedy.js';
import { parseDirectInput } from '../src/direct-input.js';

/**
 * A rendered remedy is only worth printing if a shell reproduces the exact
 * arguments it was built from. `printf '%s\n'` on each word is the cheapest
 * honest check: it makes the shell itself do the splitting and unquoting, so a
 * path with a space, an apostrophe or a `$(...)` in it either round-trips or
 * fails loudly here instead of in someone's terminal.
 */
function argv(command: string): string[] {
  const out = execFileSync('sh', ['-c', `for word in ${command}; do printf '%s\\n' "$word"; done`],
    { encoding: 'utf8' });
  return out.split('\n').slice(0, -1);
}

/** The command inside a remedy clause: between `: ` and the sentence's `. `. */
function command(clause: string): string {
  return /: (flows [^\n]*?)\. [A-Z]/.exec(clause)![1]!;
}

describe('localAgentRemedy', () => {
  it('says nothing when there is nothing to say', () => {
    expect(localAgentRemedy({ kind: 'none' })).toBe('');
  });

  it('renders a runnable new run for a declarative spec', () => {
    const clause = localAgentRemedy({ kind: 'spec-run', path: 'flows/hello.flow.yaml', dataDir: '/tmp/d' });
    // The prefix people already grep for, byte for byte, with the data dir
    // appended: `parseRunArgs` is order-insensitive, so this still parses.
    expect(clause).toContain(`flows run --local-agent 'flows/hello.flow.yaml' --data-dir /tmp/d`);
    expect(argv(command(clause)))
      .toEqual(['flows', 'run', '--local-agent', 'flows/hello.flow.yaml', '--data-dir', '/tmp/d']);
  });

  it('points a parked declarative resume at this run, not a new one', () => {
    const clause = localAgentRemedy({ kind: 'spec-resume', runId: '01RUN', dataDir: '/tmp/d' });
    // A resumable run is continued, not restarted: naming `flows run` here
    // would throw away everything the run already journaled.
    expect(clause).toContain('flows resume --data-dir /tmp/d --local-agent 01RUN');
    expect(clause).not.toContain('flows run');
  });

  it('never tells an already-attached caller to pass the same flag again', () => {
    const clause = localAgentRemedy({ kind: 'attached' });
    expect(clause).toContain('already attached');
    expect(clause).not.toMatch(/flows (run|resume)/);
    // The honest report: a worker was offered and none of them was eligible.
    expect(clause).toContain('no attached worker was eligible');
  });

  it('carries the authored --input through the shell unchanged', () => {
    const argument = '{"plan":"v2","note":"it\'s fine","shell":"$(rm -rf /)"}';
    const clause = localAgentRemedy({
      kind: 'authored-run', path: "my flows/a b's.flow.ts", input: { kind: 'inline', argument },
    });
    expect(argv(command(clause)))
      .toEqual(['flows', 'run', '--local-agent', "my flows/a b's.flow.ts", '--input', argument]);
  });

  /**
   * A resume renders the recorded input back as inline JSON, and the journal
   * keeps everything the run was started with — so this clause routinely
   * carries far more than a filename's worth of bytes. `parseDirectInput`
   * `stat`s the argument first, and a `stat` of a 300-byte word fails
   * ENAMETOOLONG rather than ENOENT; treating that as "could not be inspected"
   * made the printed remedy fail at exit 2 instead of attaching a worker.
   */
  it('renders an input longer than a filename as a word both the shell and the parser accept', () => {
    const argument = JSON.stringify({ task: 'x'.repeat(300) });
    expect(argument.length).toBeGreaterThan(255);

    const clause = localAgentRemedy({
      kind: 'authored-run', path: 'a.flow.ts', input: { kind: 'inline', argument },
    });

    const words = argv(command(clause));
    expect(words).toEqual(['flows', 'run', '--local-agent', 'a.flow.ts', '--input', argument]);
    // The parser the printed command actually reaches, on the word the shell
    // actually delivers: it must read as inline JSON, not as an unreadable file.
    expect(parseDirectInput(words.at(-1)!)).toEqual({ task: 'x'.repeat(300) });
  });

  it('states the requirement rather than inventing an input it does not have', () => {
    const clause = localAgentRemedy({ kind: 'authored-run', path: 'a.flow.ts', input: { kind: 'absent' } });
    expect(clause).toContain('no input argument to repeat here');
    // It names `--input` as a requirement but never supplies a value: `{}`
    // would start a different invocation than the one that parked, and a
    // `<placeholder>` would be a shell redirect rather than an argument. With
    // no value there is no command to print either.
    expect(clause).not.toMatch(/--input '/);
    expect(clause).not.toContain('flows run');
  });

  /**
   * `MAX_DIRECT_INPUT_BYTES` admits a mebibyte; Linux `execve` admits 128KiB
   * in one argument. An input file between the two is ordinary, and printing
   * its contents back inline yields a command that dies with `Argument list
   * too long` before the CLI is reached.
   */
  it('refuses to print an input larger than a shell argument, and says so', () => {
    const clause = localAgentRemedy({
      kind: 'authored-run', path: 'a.flow.ts', input: { kind: 'oversized', bytes: 200_000 },
    });
    expect(clause).toContain('200000 bytes of input');
    expect(clause).toContain('pass the input file this run was started from');
    expect(clause).not.toMatch(/--input '/);
    expect(clause).not.toContain('flows run --local-agent');
  });
});

describe('authoredInput', () => {
  it('keeps an argument a shell can carry', () => {
    expect(authoredInput('{"plan":"v2"}')).toEqual({ kind: 'inline', argument: '{"plan":"v2"}' });
  });

  it('reports an absent argument as absent rather than empty', () => {
    expect(authoredInput(undefined)).toEqual({ kind: 'absent' });
  });

  /**
   * The boundary is measured in bytes, not characters: `execve` counts bytes,
   * so a multi-byte document has to be weighed the way the kernel weighs it.
   */
  it('classifies by encoded bytes at the execve limit', () => {
    expect(authoredInput('x'.repeat(131_071))).toMatchObject({ kind: 'inline' });
    expect(authoredInput('x'.repeat(131_072))).toEqual({ kind: 'oversized', bytes: 131_072 });
    // 65_536 two-byte characters is 131_072 bytes: over the limit despite
    // being half its length in UTF-16 code units.
    expect(authoredInput('é'.repeat(65_536))).toEqual({ kind: 'oversized', bytes: 131_072 });
  });
});

describe('authoredWorkerRemedy', () => {
  const run = { path: 'a.flow.ts', input: { kind: 'inline', argument: '{}' } as const, dataDir: '/tmp/d' };

  it('answers a worker park with a new run', () => {
    expect(authoredWorkerRemedy('worker_unavailable', false, run))
      .toEqual({ kind: 'authored-run', ...run });
  });

  it('answers an attached worker park without repeating the flag', () => {
    expect(authoredWorkerRemedy('worker_unavailable', true, run)).toEqual({ kind: 'attached' });
  });

  /// Attaching a worker does not clear the kernel's manual-recovery wait, and
  /// an unestablished cause is not evidence of one. Both stay silent rather
  /// than sending someone to fix a thing that is not broken.
  it.each([['needs_human'], [undefined]] as const)('says nothing for %s', (cause) => {
    expect(authoredWorkerRemedy(cause, false, run)).toEqual({ kind: 'none' });
  });

  it('says nothing when the flow path is unknown', () => {
    expect(authoredWorkerRemedy('worker_unavailable', false, { input: { kind: 'absent' } }))
      .toEqual({ kind: 'none' });
  });
});
