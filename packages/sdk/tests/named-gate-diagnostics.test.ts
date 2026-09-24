import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { compileSpec } from '../src/compile.js';
import { lowerNamedGates } from '../src/named-gate-lowering.js';
import type { NamedDataGate, StepSpec } from '../src/spec.js';

/**
 * These cases run the REAL lowered command the way the kernel runs it — piped
 * stdout and stderr, `FLOWS_INPUT` in the environment (exec_det.rs:72-78) — and
 * assert on the captured streams. They establish stream capture and the
 * diagnostics; the journal itself is asserted against a live daemon in
 * `named-gate-journal.test.ts`, because a captured pipe is not a journal write.
 */

const directories: string[] = [];
afterEach(() => { for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true }); });

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'gate-diagnostics-'));
  directories.push(directory);
  return directory;
}

/** The command the compiler actually emits for `<producer>.gate`. */
function gateCommand(gate: NamedDataGate, producer: 'deterministic' | 'agent' = 'deterministic'): string {
  // `references_input` names a declared input binding, so the producer needs a
  // real upstream to bind to; every other gate reads the producer's output.
  const referencing = gate.type === 'references_input';
  const source = {
    id: 'source', type: 'deterministic', command: 'true',
    verification: { type: 'json_schema', schema: { type: 'object', properties: { text: { type: 'string' } } } },
  };
  const step = producer === 'deterministic'
    ? { id: 'produce', type: 'deterministic', command: 'true', verification: gate }
    : { id: 'produce', type: 'agent', instruction: 'work', cli: 'stub', verification: gate };
  const spec = compileSpec({
    version: '0.1.0', name: 'gated',
    steps: (referencing
      ? [source, { ...step, input: { reference: { step: 'source', path: ['text'] } } }]
      : [step]) as StepSpec[],
  });
  const barrier = lowerNamedGates(spec.steps).find(candidate => candidate.id === 'produce.gate');
  const command = (barrier as { command?: string } | undefined)?.command;
  if (command === undefined) throw new Error('no gate step was lowered');
  return command;
}

interface Capture { status: number | null; stdout: string; stderr: string }

/**
 * `input` is the resolved binding the kernel puts in FLOWS_INPUT — the gate's
 * own `input` is `{ output: <producer envelope> }` (+ `reference` for
 * references_input), never the raw envelope.
 */
function runGate(command: string, input: Record<string, unknown>, options: { path?: string } = {}): Capture {
  const result = spawnSync('/bin/sh', ['-c', command], {
    encoding: 'utf8',
    env: {
      ...process.env,
      FLOWS_INPUT: JSON.stringify(input),
      ...(options.path === undefined ? {} : { PATH: `${options.path}:${process.env['PATH'] ?? ''}` }),
    },
  });
  if (result.error !== undefined) throw result.error;
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** A deterministic producer's journaled envelope. */
const deterministicEnvelope = (stdout: string) => ({ exit_code: 0, stdout_tail: stdout, stderr_tail: '' });

describe('a subprocess_gate keeps the gate command\'s own streams', () => {
  const gate = (command: string): NamedDataGate =>
    ({ type: 'subprocess_gate', command, from_output: ['stdout_tail'] });

  it('captures stdout and stderr when the command fails', () => {
    const command = gateCommand(gate("printf 'GATE_FAILED %s' \"$INPUT\" >&2; printf 'on stdout'; exit 1"));
    const capture = runGate(command, { output: deterministicEnvelope('the reviewed text') });

    expect(capture.status).toBe(1);
    expect(capture.stdout).toContain('on stdout');
    expect(capture.stderr).toContain('GATE_FAILED the reviewed text');
  });

  it('captures stdout and stderr when the command passes', () => {
    const command = gateCommand(gate("printf 'GATE_PASSED detail'; printf 'a warning' >&2"));
    const capture = runGate(command, { output: deterministicEnvelope('the reviewed text') });

    expect(capture.status).toBe(0);
    expect(capture.stdout).toContain('GATE_PASSED detail');
    expect(capture.stderr).toContain('a warning');
  });

  it('selects the whole envelope for a non-deterministic producer', () => {
    // An agent's envelope has no implicit `stdout_tail` selection, so a gate
    // without `from_output` receives the serialized envelope — the shape the
    // reported incident's gate was handed.
    const command = gateCommand({ type: 'subprocess_gate', command: 'printf %s "$INPUT"; exit 1' }, 'agent');
    const capture = runGate(command, { output: { exit_code: 0, stdout_tail: 'drafted', artifacts: ['a.md'] } });

    expect(capture.status).toBe(1);
    expect(JSON.parse(capture.stdout)).toEqual({ exit_code: 0, stdout_tail: 'drafted', artifacts: ['a.md'] });
  });
});

describe('a gate that fails before the command runs says so', () => {
  const sentinel = "printf 'THE-COMMAND-RAN'";

  it('names the selection that missed, and does not run the command', () => {
    const command = gateCommand({ type: 'subprocess_gate', command: sentinel, from_output: ['review', 'verdict'] });
    const capture = runGate(command, { output: { review: { note: 'no verdict here' } } });

    expect(capture.status).toBe(1);
    expect(capture.stdout).not.toContain('THE-COMMAND-RAN');
    expect(capture.stderr).toContain('subprocess_gate');
    expect(capture.stderr).toContain('from_output ["review","verdict"]');
    expect(capture.stderr).toContain('"verdict"');
  });

  it('reports an index into an object and a key into an array as selection failures', () => {
    const indexed = gateCommand({ type: 'subprocess_gate', command: sentinel, from_output: [0] });
    expect(runGate(indexed, { output: { '0': 'not an array' } }).stderr).toContain('from_output [0]');

    const keyed = gateCommand({ type: 'subprocess_gate', command: sentinel, from_output: ['name'] });
    expect(runGate(keyed, { output: ['an', 'array'] }).stderr).toContain('from_output ["name"]');
  });

  it('reports a selected value that is not text', () => {
    const command = gateCommand({ type: 'subprocess_gate', command: sentinel });
    // A deterministic producer whose envelope has no `stdout_tail` at all:
    // `JSON.stringify(undefined)` is `undefined`, not a string.
    const capture = runGate(command, { output: { exit_code: 0 } });

    expect(capture.status).toBe(1);
    expect(capture.stdout).not.toContain('THE-COMMAND-RAN');
    expect(capture.stderr).toContain('could not be read as text');
  });

  it('reports a NUL byte in the selected text', () => {
    const command = gateCommand({ type: 'subprocess_gate', command: sentinel, from_output: ['stdout_tail'] });
    const capture = runGate(command, { output: deterministicEnvelope('before\0after') });

    expect(capture.status).toBe(1);
    expect(capture.stdout).not.toContain('THE-COMMAND-RAN');
    expect(capture.stderr).toContain('NUL byte');
  });

  it('still runs the command for the literal characters backslash and zero', () => {
    const command = gateCommand({ type: 'subprocess_gate', command: sentinel, from_output: ['stdout_tail'] });
    const capture = runGate(command, { output: deterministicEnvelope('a literal \\0 sequence') });

    expect(capture.status).toBe(0);
    expect(capture.stdout).toContain('THE-COMMAND-RAN');
    expect(capture.stderr).toBe('');
  });

  it('keeps the diagnostic to one line so it cannot be mistaken for command output', () => {
    const command = gateCommand({ type: 'subprocess_gate', command: sentinel, from_output: ['a\nb'] });
    const capture = runGate(command, { output: { other: 1 } });

    expect(capture.stderr).toContain('from_output');
    expect(capture.stderr.trim().split('\n')).toHaveLength(1);
  });
});

describe('a gate command that never exits normally is not reported as a plain failure', () => {
  it('names the signal that killed it', () => {
    const command = gateCommand({
      type: 'subprocess_gate', command: 'printf partial; kill -9 $$', from_output: ['stdout_tail'],
    });
    const capture = runGate(command, { output: deterministicEnvelope('text') });

    expect(capture.status).toBe(1);
    // `inherit` means the bytes written before the kill are already in the
    // kernel's pipe; buffering them for a post-wait flush would lose them.
    expect(capture.stdout).toContain('partial');
    expect(capture.stderr).toContain('SIGKILL');
  });

  it('names the spawn error and the input size when the child cannot start', () => {
    // The real generated program, with `node:child_process` stubbed to the
    // E2BIG shape (`status: null`, `error.code`) an oversized environment
    // produces. A nonexistent command would exit 127 through /bin/sh and
    // never reach this branch.
    const directory = temporaryDirectory();
    const preload = join(directory, 'stub-spawn.cjs');
    writeFileSync(preload, `const Module = require('node:module');
const load = Module._load;
Module._load = function (request, ...rest) {
  if (request !== 'node:child_process') return load.call(this, request, ...rest);
  return { spawnSync: () => ({
    error: Object.assign(new Error('spawnSync /bin/sh E2BIG'), { code: 'E2BIG' }),
    status: null, signal: null, stdout: null, stderr: null,
  }) };
};
`);
    writeFileSync(join(directory, 'node'), `#!/bin/sh
exec ${JSON.stringify(process.execPath)} --require ${JSON.stringify(preload)} "$@"
`);
    chmodSync(join(directory, 'node'), 0o755);

    const command = gateCommand({ type: 'subprocess_gate', command: 'true', from_output: ['stdout_tail'] });
    const capture = runGate(command, { output: deterministicEnvelope('0123456789') }, { path: directory });

    expect(capture.status).toBe(1);
    expect(capture.stderr).toContain('E2BIG');
    expect(capture.stderr).toContain('10 bytes');
  });
});

describe('diagnostics never reach the stdout a gate verdict is read from', () => {
  it('leaves references_input stdout empty when the selection misses', () => {
    const command = gateCommand({ type: 'references_input', input_key: 'reference', in_output_at: ['missing'] });
    const capture = runGate(command, { output: { present: 'x' }, reference: 'a required substring' });

    expect(capture.status).toBe(1);
    expect(capture.stdout).toBe('');
    expect(capture.stderr).toContain('in_output_at ["missing"]');
    // The receipt `output_contains` looks for must never be forgeable by a
    // diagnostic that merely names the gate.
    expect(capture.stdout + capture.stderr).not.toContain('references_input:pass');
  });

  it('leaves regex_match stdout empty when the selection misses', () => {
    const command = gateCommand({ type: 'regex_match', pattern: 'ok', in_output_at: ['missing'] });
    const capture = runGate(command, { output: { present: 'x' } });

    expect(capture.status).toBe(1);
    expect(capture.stdout).toBe('');
    expect(capture.stderr).toContain('regex_match');
  });

  it('keeps word_count_bounds stdout a bare decimal on success', () => {
    const command = gateCommand({ type: 'word_count_bounds', min: 1, max: 5 });
    const capture = runGate(command, { output: deterministicEnvelope('one two three') });

    expect(capture.status).toBe(0);
    expect(capture.stdout).toBe('3');
    expect(capture.stderr).toBe('');
  });
});

describe('word_count_bounds reports why its own child failed', () => {
  /** A `wc` earlier on PATH than the real one, behaving as the test needs. */
  function stubWordCount(script: string): string {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, 'wc'), `#!/bin/sh\n${script}\n`);
    chmodSync(join(directory, 'wc'), 0o755);
    return directory;
  }

  const command = () => gateCommand({ type: 'word_count_bounds', min: 1, max: 5 });

  it('reports a nonzero exit with what wc said', () => {
    const path = stubWordCount("printf 'wc: read error' >&2; exit 2");
    const capture = runGate(command(), { output: deterministicEnvelope('one two') }, { path });

    expect(capture.status).toBe(1);
    expect(capture.stdout).toBe('');
    expect(capture.stderr).toContain('exited 2');
    expect(capture.stderr).toContain('wc: read error');
  });

  it('reports output that is not a count', () => {
    const path = stubWordCount("printf 'not a number'");
    const capture = runGate(command(), { output: deterministicEnvelope('one two') }, { path });

    expect(capture.status).toBe(1);
    expect(capture.stdout).toBe('');
    expect(capture.stderr).toContain('not a number');
  });

  it('reports a signal rather than an empty exit 1', () => {
    const path = stubWordCount('kill -9 $$');
    const capture = runGate(command(), { output: deterministicEnvelope('one two') }, { path });

    expect(capture.status).toBe(1);
    expect(capture.stderr).toContain('SIGKILL');
  });
});
