import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { runAgentCli } from '../src/worker-cli.js';

/**
 * What the 300 s execution deadline was really doing for a session that had
 * none of its own business with duration: settling a wrapper that exited while
 * something it spawned still held an inherited stdio pipe, because Node emits
 * `'close'` only once every one of them is closed.
 *
 * That job outlives the deadline, so it is keyed on the fact that actually
 * matters — the wrapper's own `'exit'` — and bounded by a drain grace and a
 * reader-owned settle after escalation. These tests pin the bound and the
 * reported result for a session with NO execution deadline, which is now the
 * only configuration the product reaches.
 *
 * Reaching the end of a grace is not proof that a pipe was leaked, and
 * settling is not proof that an escaped descendant was reaped. What is
 * asserted here is settlement and the value settled on.
 */

/** Long enough that a holder outliving the settle is unambiguous in the elapsed bound. */
const HOLD_MS = 3_000;
/** Drain grace (250 ms) plus spawn and handshake overhead, well under {@link HOLD_MS}. */
const SETTLE_BOUND_MS = 2_000;

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function makeDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'flows-wrapper-drain-'));
  directories.push(directory);
  return directory;
}

/**
 * A helper that inherits `stdio` and holds it, so `'close'` cannot arrive
 * until it is gone.
 *
 * `detached` decides whether a stop can reach it at all. A detached holder
 * leads a group of its own and, once the wrapper it came from is dead, is no
 * longer traceable to this spawn — the reader settles immediately, because
 * there is nothing left to wait for. One left in the wrapper's group is
 * reachable, and combined with `deaf` (which ignores `SIGTERM`) it is what
 * makes the post-escalation settle window observable at all.
 */
function pipeHolder(
  stdio: 'inherit' | readonly string[],
  { deaf = false, detached = true }: { deaf?: boolean; detached?: boolean } = {},
): string {
  const script = `${deaf ? 'process.on(\'SIGTERM\', () => {});' : ''}setTimeout(() => {}, ${HOLD_MS});`;
  return `
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', ${JSON.stringify(script)}], {
  stdio: ${JSON.stringify(stdio)}, detached: ${String(detached)},
}).unref();
`;
}

/** A conforming wrapper that emits `emit`, runs `tail`, and then really exits. */
function makeWrapper(directory: string, name: string, emit: string, tail: string): string {
  const wrapper = join(directory, name);
  writeFileSync(wrapper, `#!/usr/bin/env node
process.stdout.write('relayflows-agent-cli-v1\\n');
process.stdin.resume();
process.stdin.on('end', () => {
  process.stdout.write('relayflows-agent-cli-v1-execute\\n');
${emit}
${tail}
});
`);
  chmodSync(wrapper, 0o755);
  return wrapper;
}

it('settles a wrapper that exits leaving stdout held open, at default limits', async () => {
  const directory = makeDirectory();
  const wrapper = makeWrapper(directory, 'drain-stdout', `
process.stdout.write('{"ok":"drained"}\\n');
`, `${pipeHolder('inherit')}
process.exit(0);
`);

  const started = Date.now();
  const result = await runAgentCli(wrapper, 'instruction', undefined, undefined, undefined, undefined, 'agent', undefined, directory);
  const elapsed = Date.now() - started;

  expect(result.stderr_tail).toBe('');
  expect(result.exit_code).toBe(0);
  expect(result.stdout_tail).toBe('{"ok":"drained"}\n');
  expect(elapsed).toBeLessThan(SETTLE_BOUND_MS);
}, 20_000);

/**
 * `['ignore', 'ignore', 'inherit']`, which is stderr and nothing else. The
 * existing "stderr only" case in `worker-cli.test.ts` passes
 * `['ignore', 'inherit', 'ignore']` — that is stdout — so this path had no
 * coverage under its own name.
 */
it('settles a wrapper that exits leaving only stderr held open', async () => {
  const directory = makeDirectory();
  const wrapper = makeWrapper(directory, 'drain-stderr', `
process.stdout.write('{"ok":"stderr-held"}\\n');
`, `${pipeHolder(['ignore', 'ignore', 'inherit'])}
process.exit(0);
`);

  const started = Date.now();
  const result = await runAgentCli(wrapper, 'instruction', undefined, undefined, undefined, undefined, 'agent', undefined, directory);
  const elapsed = Date.now() - started;

  expect(result.exit_code).toBe(0);
  expect(result.stdout_tail).toBe('{"ok":"stderr-held"}\n');
  expect(elapsed).toBeLessThan(SETTLE_BOUND_MS);
}, 20_000);

it('reports the wrapper’s nonzero exit code rather than the drain', async () => {
  const directory = makeDirectory();
  const wrapper = makeWrapper(directory, 'drain-nonzero', `
process.stdout.write('partial work\\n');
process.stderr.write('wrapper said no\\n');
`, `${pipeHolder('inherit')}
process.exit(3);
`);

  const result = await runAgentCli(wrapper, 'instruction', undefined, undefined, undefined, undefined, 'agent', undefined, directory);

  expect(result.exit_code).toBe(3);
  expect(result.stdout_tail).toBe('partial work\n');
  expect(result.stderr_tail).toBe('wrapper said no\n');
}, 20_000);

it('reports a signalled wrapper death while a pipe is held, with its output intact', async () => {
  const directory = makeDirectory();
  const wrapper = makeWrapper(directory, 'drain-signal', `
process.stdout.write('{"ok":"signalled"}\\n');
`, `${pipeHolder('inherit')}
setTimeout(() => process.kill(process.pid, 'SIGKILL'), 100);
`);

  const result = await runAgentCli(wrapper, 'instruction', undefined, undefined, undefined, undefined, 'agent', undefined, directory);

  // A signalled exit has no code. It is NOT a refusal: the output stands and
  // `stderr_tail` stays empty, which is what separates the two shapes.
  expect(result.exit_code).toBeNull();
  expect(result.stderr_tail).toBe('');
  expect(result.stdout_tail).toBe('{"ok":"signalled"}\n');
}, 20_000);

/**
 * The un-terminated final line is spent by whichever settle gets there first.
 * It used to be folded in by `'close'` alone; now the drain can finalize too,
 * and appending it twice would duplicate the wrapper's whole result.
 */
it('flushes an un-terminated final line exactly once when the drain settles', async () => {
  const directory = makeDirectory();
  const wrapper = makeWrapper(directory, 'drain-partial', `
process.stdout.write('{"ok":"no trailing newline"}');
`, `${pipeHolder('inherit')}
process.exit(0);
`);

  const result = await runAgentCli(wrapper, 'instruction', undefined, undefined, undefined, undefined, 'agent', undefined, directory);

  expect(result.exit_code).toBe(0);
  expect(result.stdout_tail).toBe('{"ok":"no trailing newline"}');
}, 20_000);

it('refuses a duplicate execute frame found at finalization, despite a clean exit', async () => {
  const directory = makeDirectory();
  const wrapper = makeWrapper(directory, 'drain-duplicate', `
process.stdout.write('relayflows-agent-cli-v1-execute');
`, `${pipeHolder('inherit')}
process.exit(0);
`);

  const result = await runAgentCli(wrapper, 'instruction', undefined, undefined, undefined, undefined, 'agent', undefined, directory);

  // No newline, so the frame is only recognisable once the buffer is spent —
  // and the refusal outranks the exit 0 the process went on to report.
  expect(result.exit_code).toBeNull();
  expect(result.stdout_tail).toBe('');
  expect(result.stderr_tail).toMatch(/emitted a duplicate execute protocol frame/i);
}, 20_000);

/**
 * Bytes written into the inherited pipe after the session finalized belong to
 * nobody: the result is built and the captured budget is spent.
 */
it('ignores output a holder writes after the drain has settled', async () => {
  const directory = makeDirectory();
  const wrapper = makeWrapper(directory, 'drain-late-write', `
process.stdout.write('{"ok":"early"}\\n');
`, `
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', ${JSON.stringify(
  `setTimeout(() => process.stdout.write('LATE\\n'), 1200); setTimeout(() => {}, ${HOLD_MS});`,
)}], { stdio: 'inherit', detached: true }).unref();
process.exit(0);
`);

  const started = Date.now();
  const result = await runAgentCli(wrapper, 'instruction', undefined, undefined, undefined, undefined, 'agent', undefined, directory);
  const elapsed = Date.now() - started;

  expect(result.stdout_tail).toBe('{"ok":"early"}\n');
  // Settled before the late write could even be attempted, which is the only
  // reason the assertion above is about the reader and not about timing.
  expect(elapsed).toBeLessThan(1_200);
}, 20_000);

/**
 * A lease abort during post-exit cleanup. The window is opened deliberately: a
 * `SIGTERM`-deaf holder means the drain's escalation cannot settle before its
 * force kill a second later, so an abort at ~500 ms lands inside it rather
 * than racing it.
 */
it('lets a lease abort outrank a successful exit still being drained', async () => {
  const directory = makeDirectory();
  const exited = join(directory, 'exited');
  const controller = new AbortController();
  const wrapper = makeWrapper(directory, 'drain-aborted', `
process.stdout.write('{"ok":"must not be reported"}\\n');
`, `${pipeHolder('inherit', { deaf: true, detached: false })}
require('node:fs').writeFileSync(${JSON.stringify(exited)}, 'gone');
process.exit(0);
`);

  let running: Promise<unknown> | undefined;
  try {
    running = runAgentCli(wrapper, 'instruction', undefined, undefined, undefined, controller.signal, 'agent', undefined, directory);
    const deadline = Date.now() + 10_000;
    while (!existsSync(exited) && Date.now() < deadline) {
      await new Promise(resume => setTimeout(resume, 5));
    }
    expect(existsSync(exited), 'the wrapper never exited').toBe(true);
    await new Promise(resume => setTimeout(resume, 500));
    controller.abort(new Error('lease rejected'));

    const result = await running as { exit_code: number | null; stdout_tail: string; stderr_tail: string };
    expect(result.exit_code).toBeNull();
    expect(result.stdout_tail).toBe('');
    expect(result.stderr_tail).toBe('Agent execution aborted: lease ownership lost.');
  } finally {
    if (!controller.signal.aborted) controller.abort();
    await running?.catch(() => undefined);
  }
}, 20_000);
